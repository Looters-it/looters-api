import { Kafka, logLevel, type Producer } from "kafkajs";

/**
 * Message asking `jobs` to resolve a battle. Battles are always resolved by
 * `jobs`, so the formula exists in one place. The message carries ids only:
 * `jobs` reads the battle (and the defender's recorded response) from the database.
 */
export interface BattleResolveMessage {
  battleId: string;
  matchId: string;
}

export interface BattleQueue {
  /** Asks for the battle to be resolved now. Rejects if the message was not acknowledged. */
  requestResolution(message: BattleResolveMessage): Promise<void>;
  isConnected(): boolean;
  close(): Promise<void>;
}

export interface BattleQueueOptions {
  brokers: string[];
  topic: string;
  clientId?: string;
  onError?: (error: unknown) => void;
}

/** Serialises a message. The key keeps the battles of one match in order on one partition. */
export function encodeBattleResolve(message: BattleResolveMessage): { key: string; value: string } {
  return {
    key: message.matchId,
    value: JSON.stringify({ battleId: message.battleId, matchId: message.matchId }),
  };
}

/**
 * Connects the Kafka producer in the background and keeps retrying, so the
 * api starts even while the broker is still booting.
 *
 * Delivery is at-least-once and resolution in `jobs` is idempotent. A battle
 * whose message is lost is still resolved when its turn closes.
 */
export function createBattleQueue(options: BattleQueueOptions): BattleQueue {
  const { brokers, topic, clientId = "gioco-api", onError } = options;
  const kafka = new Kafka({ clientId, brokers, logLevel: logLevel.NOTHING });
  const producer: Producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });

  let connected = false;
  let closed = false;
  let retryTimer: NodeJS.Timeout | null = null;

  producer.on(producer.events.CONNECT, () => {
    connected = true;
  });
  producer.on(producer.events.DISCONNECT, () => {
    connected = false;
  });

  const connect = () => {
    producer.connect().catch((error: unknown) => {
      onError?.(error);
      if (!closed) retryTimer = setTimeout(connect, 5000);
    });
  };
  connect();

  return {
    async requestResolution(message) {
      await producer.send({ topic, acks: -1, messages: [encodeBattleResolve(message)] });
    },
    isConnected: () => connected,
    async close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      await producer.disconnect();
    },
  };
}
