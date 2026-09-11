import type { Candle, Quote } from "../types";

/**
 * Uscita gestita dal worker per m1_short e m1_range: nessun take profit inviato al broker e
 * nessun limite di durata. L'ordine parte con il solo SL iniziale, il target1 sposta lo stop a
 * breakeven e da li' in poi lo stop segue la struttura M5. Lo stop non torna mai indietro.
 *
 * Qui dentro non si parla con MetaApi ne' con il database: sono funzioni pure, il worker le usa
 * per decidere e gli scenari offline per verificarle.
 */

/** Distanza fissa dallo swing M5 usata dal trailing. */
export const TRAILING_BUFFER_USD = 0.2;

export type ManagedCloseReason =
  | "sl_initial" | "sl_breakeven" | "sl_trailing" | "tp_broker" | "target1"
  | "flatten" | "stop" | "watchdog" | "manual"
  // SLTP_MODE=fixed|trailing (dynamicSlTp.ts): tp_fixed prima del trigger di estensione, tp_trailing
  // dopo. sltp_rejected e' l'ultima spiaggia quando il broker ha rifiutato due volte sia lo SL sia
  // il TP calcolati e non resta nessun livello noto a cui attribuire la chiusura.
  | "tp_fixed" | "tp_trailing" | "sltp_rejected"
  // exit_mode=fast (exitMode.ts): unico livello, mandato al broker come TP, nessun breakeven/trailing.
  | "tp_fast";

/** Tick del simbolo: la granularita' con cui si riconosce "chiuso su quel livello". */
export const PRICE_TICK_USD = 0.01;

/**
 * Tolleranza con cui una chiusura viene attribuita a un livello. E' piu' larga di un tick perche'
 * uno stop o un TP eseguiti dal broker slittano quasi sempre di qualche centesimo: con un tick
 * secco ogni stop slittato finirebbe etichettato "manual". Resta stretta rispetto alle distanze
 * in gioco (SL 3-8$), quindi due livelli distinti non si confondono mai.
 */
export const CLOSE_LEVEL_TOLERANCE_USD = 0.1;

/** I due setup a uscita gestita. La mtf mantiene il TP al broker e non passa mai di qui. */
export function isManagedSetup(setup: string | null | undefined) {
  return setup === "m1_short" || setup === "m1_range";
}

export type ManagedExitState = {
  positionId: string;
  signalId: string | null;
  setup: string;
  direction: "BUY" | "SELL";
  openPrice: number;
  initialStop: number;
  /** Il livello che il codice calcolava come TP: resta un obiettivo interno, non va al broker. */
  target1: number;
  /** TP di sicurezza inviato al broker: scatta solo se worker o MetaApi muoiono. Non si muove mai. */
  brokerTp: number | null;
  stopLoss: number;
  target1Hit: boolean;
  breakevenPrice: number | null;
  breakevenAt: string | null;
  trailingUpdates: number;
  /** Distanza target1-entry del piano, per ricalcolare target1 sul prezzo di fill reale. */
  target1Distance: number;
  /** true finche' si sta usando l'entry teorica invece del fill reale. */
  fillPending: boolean;
};

export type ManagedAction =
  | { kind: "breakeven"; stopLoss: number; at: string }
  | { kind: "trailing"; from: number; to: number; swingAt: string };

export function openManagedExit(input: {
  positionId: string;
  signalId: string | null;
  setup: string;
  direction: "BUY" | "SELL";
  openPrice: number;
  initialStop: number;
  target1: number;
  brokerTp?: number | null;
  target1Distance?: number;
  fillPending?: boolean;
}): ManagedExitState {
  const target1Distance = input.target1Distance
    ?? Math.abs(input.target1 - input.openPrice);
  return {
    positionId: input.positionId,
    signalId: input.signalId,
    setup: input.setup,
    direction: input.direction,
    openPrice: input.openPrice,
    initialStop: input.initialStop,
    target1: input.target1,
    brokerTp: input.brokerTp ?? null,
    stopLoss: input.initialStop,
    target1Hit: false,
    breakevenPrice: null,
    breakevenAt: null,
    trailingUpdates: 0,
    target1Distance,
    fillPending: input.fillPending ?? false,
  };
}

/**
 * Prezzo di fill reale arrivato: target1 si rimisura dal fill, non dall'entry teorica.
 * Lo stop iniziale non si tocca — e' quello che ha davvero il broker. Dopo il breakeven la
 * gestione e' gia' partita e non si riscrive piu' nulla.
 */
export function retargetOnFill(state: ManagedExitState, fillPrice: number): ManagedExitState {
  if (!Number.isFinite(fillPrice) || fillPrice <= 0) return state;
  if (state.target1Hit || fillPrice === state.openPrice) {
    return { ...state, openPrice: state.target1Hit ? state.openPrice : fillPrice, fillPending: false };
  }
  const target1 = state.direction === "BUY"
    ? Math.floor((fillPrice + state.target1Distance) * 100) / 100
    : Math.ceil((fillPrice - state.target1Distance) * 100) / 100;
  return { ...state, openPrice: fillPrice, target1, fillPending: false };
}

/**
 * TP di sicurezza al broker: abbastanza lontano da non interferire con la gestione del worker,
 * ma sempre presente perche' se worker o MetaApi muoiono la posizione non resti senza uscita.
 */
export function safetyTakeProfit(
  direction: "BUY" | "SELL",
  entry: number,
  target1: number,
  atrM1: number,
  atrMult: number,
  minR: number,
) {
  const distance = Math.max(atrM1 * atrMult, Math.abs(target1 - entry) * minR);
  const raw = direction === "BUY" ? entry + distance : entry - distance;
  return direction === "BUY" ? Math.floor(raw * 100) / 100 : Math.ceil(raw * 100) / 100;
}

/** Prezzo di riferimento sul tick: BID per un long, ASK per uno short. */
export function referencePrice(direction: "BUY" | "SELL", quote: Quote) {
  return direction === "BUY" ? quote.bid : quote.ask;
}

export function target1Reached(state: ManagedExitState, quote: Quote) {
  const price = referencePrice(state.direction, quote);
  return state.direction === "BUY" ? price >= state.target1 : price <= state.target1;
}

/** Lo stop lo esegue il broker: questa e' la stessa lettura, usata da log e scenari. */
export function stopHit(state: ManagedExitState, quote: Quote) {
  const price = referencePrice(state.direction, quote);
  return state.direction === "BUY" ? price <= state.stopLoss : price >= state.stopLoss;
}

/** Breakeven: prezzo di apertura piu' il buffer per un long, meno il buffer per uno short. */
export function breakevenStop(direction: "BUY" | "SELL", openPrice: number, buffer: number) {
  const raw = direction === "BUY" ? openPrice + buffer : openPrice - buffer;
  return Math.round(raw * 100) / 100;
}

/**
 * Ultimo swing M5 confermato, con una candela per lato: la candela in formazione non arriva qui,
 * l'array contiene solo M5 chiuse.
 */
export function lastSwing(m5: Candle[], kind: "high" | "low"): Candle | null {
  for (let i = m5.length - 2; i >= 1; i--) {
    if (kind === "high" && m5[i].high > m5[i - 1].high && m5[i].high > m5[i + 1].high) return m5[i];
    if (kind === "low" && m5[i].low < m5[i - 1].low && m5[i].low < m5[i + 1].low) return m5[i];
  }
  return null;
}

export function trailingStop(direction: "BUY" | "SELL", m5: Candle[]) {
  const swing = lastSwing(m5, direction === "BUY" ? "low" : "high");
  if (!swing) return null;
  const level = direction === "BUY"
    ? Math.floor((swing.low - TRAILING_BUFFER_USD) * 100) / 100
    : Math.ceil((swing.high + TRAILING_BUFFER_USD) * 100) / 100;
  return { level, bar: swing };
}

/** Lo stop si muove solo a favore: piu' alto sui long, piu' basso sugli short. */
export function improvesStop(direction: "BUY" | "SELL", current: number, candidate: number) {
  return direction === "BUY" ? candidate > current : candidate < current;
}

/** Primo tick che tocca target1: lo stop va a breakeven, una volta sola. */
export function tickAction(state: ManagedExitState, quote: Quote, nowMs: number, buffer: number): ManagedAction | null {
  if (state.target1Hit || !target1Reached(state, quote)) return null;
  return { kind: "breakeven", stopLoss: breakevenStop(state.direction, state.openPrice, buffer), at: new Date(nowMs).toISOString() };
}

/** Trailing sulla struttura M5: solo dopo il breakeven e solo alla chiusura di una M5. */
export function m5CloseAction(state: ManagedExitState, m5: Candle[]): ManagedAction | null {
  if (!state.target1Hit || state.breakevenPrice === null) return null;
  const trail = trailingStop(state.direction, m5);
  if (!trail || !improvesStop(state.direction, state.stopLoss, trail.level)) return null;
  return { kind: "trailing", from: state.stopLoss, to: trail.level, swingAt: trail.bar.datetime };
}

export function applyAction(state: ManagedExitState, action: ManagedAction): ManagedExitState {
  if (action.kind === "breakeven") {
    return { ...state, target1Hit: true, stopLoss: action.stopLoss, breakevenPrice: action.stopLoss, breakevenAt: action.at };
  }
  return { ...state, stopLoss: action.to, trailingUpdates: state.trailingUpdates + 1 };
}

/** Posizione live MetaApi: solo i campi che servono a recuperare un TP altrimenti sconosciuto. */
export type BrokerPositionLike = { takeProfit?: number | null };

/**
 * TP corrente da ripassare a OGNI modifyPosition di breakeven/trailing, mai omesso: un TP omesso
 * viene letto dal broker come "cancellalo", non "lascialo com'era" (vedi trade MT5 #220522199, TP
 * sparito dopo un breakeven che mandava solo lo stopLoss). Preferisce lo stato interno (gia' noto
 * e persistito in tp_broker); se assente ripiega sul TP live della posizione MetaApi, l'unica
 * altra fonte di verita' disponibile senza aggiungere colonne nuove. Restituisce null solo se
 * nessuna delle due fonti ha un valore: in quel caso il chiamante NON deve inviare la modifica.
 */
export function resolveBrokerTp(brokerTp: number | null | undefined, position: BrokerPositionLike): number | null {
  // Number(null) === 0, che e' finito: senza il controllo esplicito su null/undefined uno stato
  // "TP sconosciuto" verrebbe letto come "TP a zero" invece di ripiegare sul TP live.
  if (brokerTp !== null && brokerTp !== undefined && Number.isFinite(Number(brokerTp)) && Number(brokerTp) > 0) {
    return Number(brokerTp);
  }
  if (Number.isFinite(Number(position.takeProfit)) && Number(position.takeProfit) > 0) return Number(position.takeProfit);
  return null;
}

/**
 * Comando completo da mandare a modifyPosition per un'azione di breakeven/trailing: SEMPRE sia sl
 * sia tp espliciti, mai un campo omesso. `blocked` e' true quando il TP non e' risolvibile da
 * nessuna fonte: il chiamante deve saltare la modifica invece di mandarla con un tp mancante.
 */
export type ModifyPositionCommand =
  | { blocked: false; sl: number; tp: number }
  | { blocked: true; reason: "tp_unknown" };

export function buildModifyPositionCommand(
  action: ManagedAction,
  currentBrokerTp: number | null | undefined,
  position: BrokerPositionLike,
): ModifyPositionCommand {
  const tp = resolveBrokerTp(currentBrokerTp, position);
  if (tp === null) return { blocked: true, reason: "tp_unknown" };
  const sl = action.kind === "breakeven" ? action.stopLoss : action.to;
  return { blocked: false, sl, tp };
}

/** Livelli noti di una posizione, usati per leggere il motivo dal prezzo di chiusura reale. */
export type CloseLevels = {
  initialStop: number | null;
  breakevenStop: number | null;
  trailingStop: number | null;
  brokerTp: number | null;
  target1: number | null;
};

function near(price: number, level: number | null | undefined) {
  return level !== null && level !== undefined && Number.isFinite(level)
    && Math.abs(price - level) <= CLOSE_LEVEL_TOLERANCE_USD;
}

/**
 * Motivo di chiusura letto dal prezzo di chiusura REALE del deal, mai dedotto dallo stato interno.
 * Lo stato interno puo' essere in ritardo o sbagliato (una falsa sparizione dal terminal state
 * scriveva "sl_initial" su un trade chiuso in profitto): il prezzo no.
 *
 * Ordine: prima gli stop, dal piu' avanzato al piu' arretrato, cosi' un breakeven che coincide con
 * lo stop iniziale non viene mai contato come perdita; poi il TP di sicurezza, poi target1.
 */
export function closeReasonFromPrice(
  closePrice: number,
  profit: number,
  levels: CloseLevels,
): ManagedCloseReason {
  if (!Number.isFinite(closePrice)) return "manual";
  if (near(closePrice, levels.trailingStop)) return "sl_trailing";
  if (near(closePrice, levels.breakevenStop)) return "sl_breakeven";
  // sl_initial solo se e' davvero lo stop iniziale ad aver perso: in profitto non e' una perdita.
  if (near(closePrice, levels.initialStop) && Number.isFinite(profit) && profit < 0) return "sl_initial";
  if (near(closePrice, levels.brokerTp)) return "tp_broker";
  if (near(closePrice, levels.target1)) return "target1";
  return "manual";
}

/** Livelli noti di una posizione SLTP_MODE=fixed|trailing (dynamicSlTp.ts), letti da context_json. */
export type SltpCloseLevels = {
  currentSl: number | null;
  /** true se lo SL si e' gia' stretto almeno una volta rispetto a quello iniziale. */
  slTightened: boolean;
  currentTp: number | null;
  /** true se il trigger di estensione del TP trailing era gia' superato al momento della chiusura. */
  tpTriggered: boolean;
};

/**
 * Motivo di chiusura per le posizioni gestite da SLTP_MODE, letto anch'esso dal prezzo REALE del
 * deal quando il broker chiude prima del check attivo del worker (vedi POSITION_GONE_CONFIRM).
 * Separata da closeReasonFromPrice perche' il vocabolario e i livelli sono diversi: qui non
 * esistono breakeven ne' target1, solo lo SL corrente (sl_initial finche' non si e' mai stretto,
 * sl_trailing dopo) e il TP corrente (tp_fixed prima del trigger di estensione, tp_trailing dopo).
 */
export function sltpCloseReasonFromPrice(closePrice: number, levels: SltpCloseLevels): ManagedCloseReason {
  if (!Number.isFinite(closePrice)) return "manual";
  if (near(closePrice, levels.currentSl)) return levels.slTightened ? "sl_trailing" : "sl_initial";
  if (near(closePrice, levels.currentTp)) return levels.tpTriggered ? "tp_trailing" : "tp_fixed";
  return "manual";
}

/** Livelli noti di una posizione exit_mode=fast: solo lo SL iniziale e l'unico target al broker. */
export type FastExitCloseLevels = {
  initialStop: number | null;
  fastTarget: number | null;
};

/**
 * Motivo di chiusura per exit_mode=fast, letto anch'esso dal prezzo REALE del deal: nessun
 * breakeven ne' trailing qui, solo lo SL iniziale (sl_initial se chiuso in perdita) e il target
 * unico mandato al broker (tp_fast).
 */
export function fastExitCloseReasonFromPrice(closePrice: number, profit: number, levels: FastExitCloseLevels): ManagedCloseReason {
  if (!Number.isFinite(closePrice)) return "manual";
  if (near(closePrice, levels.initialStop) && Number.isFinite(profit) && profit < 0) return "sl_initial";
  if (near(closePrice, levels.fastTarget)) return "tp_fast";
  return "manual";
}

/**
 * Livelli attivi di un piano di uscita. Lo stop corrente vale come trailing solo se il trailing e'
 * davvero scattato, e come breakeven solo dopo che il breakeven e' stato impostato.
 */
export function closeLevelsFromState(state: Pick<ManagedExitState,
  "initialStop" | "stopLoss" | "breakevenPrice" | "brokerTp" | "target1" | "trailingUpdates">): CloseLevels {
  return {
    initialStop: state.initialStop,
    breakevenStop: state.breakevenPrice,
    trailingStop: state.trailingUpdates > 0 ? state.stopLoss : null,
    brokerTp: state.brokerTp,
    target1: state.target1,
  };
}

/** Una posizione sparita dal terminal state: da quanti tick e da quanto tempo non si vede. */
export type MissingPosition = { since: number; ticks: number };

export function trackMissing(previous: MissingPosition | undefined, nowMs: number): MissingPosition {
  return previous ? { since: previous.since, ticks: previous.ticks + 1 } : { since: nowMs, ticks: 1 };
}

/**
 * L'assenza dal terminal state non basta: MetaApi la perde per qualche tick subito dopo
 * l'apertura. Serve che manchi da abbastanza tempo E su abbastanza tick consecutivi; in
 * alternativa la conferma arriva da un deal di chiusura in history.
 */
export function closeConfirmedByAbsence(
  missing: MissingPosition | undefined,
  nowMs: number,
  confirmMs: number,
  minTicks: number,
) {
  if (!missing) return false;
  return missing.ticks >= minTicks && nowMs - missing.since >= confirmMs;
}

/** Con una posizione aperta nessun setup viene valutato per l'ingresso. */
export function entryBlockedByOpenPositions(openPositions: number, maxOpenPositions: number) {
  return openPositions >= maxOpenPositions;
}

/**
 * Un segnale nella direzione opposta a una posizione aperta non chiude e non inverte:
 * resta solo a log come ignored_opposite_signal.
 */
export function oppositeSignalIgnored(openDirections: Array<"BUY" | "SELL">, signalDirection: string) {
  return (signalDirection === "BUY" || signalDirection === "SELL")
    && openDirections.length > 0
    && !openDirections.includes(signalDirection);
}

/**
 * Conta come perdita solo lo stop iniziale chiuso in perdita. Le uscite gestite (breakeven,
 * trailing, TP di sicurezza, target1, flatten, stop, watchdog, chiusura manuale) non bloccano mai
 * una direzione. I trade senza close_reason (la mtf, che tiene il TP al broker) contano come prima.
 */
export function countsAsLoss(
  outcome: string | null | undefined,
  closeReason: string | null | undefined,
  profit?: unknown,
) {
  if (outcome !== "LOSS") return false;
  const value = Number(profit);
  if (Number.isFinite(value) && value >= 0) return false;
  return (closeReason ?? "sl_initial") === "sl_initial";
}
