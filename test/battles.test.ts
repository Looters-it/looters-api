import { Kafka, logLevel } from "kafkajs";
import { afterAll, describe, expect, it } from "vitest";
import { createBattleQueue, encodeBattleResolve } from "../src/queue/battles.js";

describe("battle resolution message", () => {
  it("is keyed by match and carries ids only", () => {
    const encoded = encodeBattleResolve({ battleId: "b1", matchId: "m1" });
    expect(encoded.key).toBe("m1");
    expect(JSON.parse(encoded.value)).toEqual({ battleId: "b1", matchId: "m1" });
  });
});

// Needs a running broker: set TEST_KAFKA_BROKERS (see .env.example).
const brokers = process.env.TEST_KAFKA_BROKERS?.split(",") ?? [];

describe.skipIf(brokers.length === 0)("battle queue on Kafka", () => {
  const topic = `test.battle.resolve.${Date.now()}`;
  const kafka = new Kafka({ clientId: "api-test", brokers, logLevel: logLevel.NOTHING });
  const admin = kafka.admin();
  const consumer = kafka.consumer({ groupId: `api-test-${Date.now()}` });
  const queue = createBattleQueue({ brokers, topic });

  afterAll(async () => {
    await queue.close();
    await consumer.disconnect();
    await admin.deleteTopics({ topics: [topic] }).catch(() => undefined);
    await admin.disconnect();
  });

  it("delivers a resolution request to a consumer", async () => {
    await admin.connect();
    await admin.createTopics({ topics: [{ topic, numPartitions: 3 }], waitForLeaders: true });

    await queue.requestResolution({ battleId: "b1", matchId: "m1" });
    await queue.requestResolution({ battleId: "b2", matchId: "m1" });
    expect(queue.isConnected()).toBe(true);

    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: true });
    const received: { key?: string; battleId: string; partition: number }[] = [];
    await new Promise<void>((resolve, reject) => {
      consumer
        .run({
          eachMessage: ({ message, partition }) => {
            const body = JSON.parse(message.value?.toString() ?? "{}") as { battleId: string };
            received.push({ key: message.key?.toString(), battleId: body.battleId, partition });
            if (received.length === 2) resolve();
            return Promise.resolve();
          },
        })
        .catch(reject);
    });

    // Same match, same partition, in the order they were sent.
    expect(received.map((r) => r.battleId)).toEqual(["b1", "b2"]);
    expect(received.every((r) => r.key === "m1")).toBe(true);
    expect(received[0]?.partition).toBe(received[1]?.partition);
  }, 30_000);
});
