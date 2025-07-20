/**
 * k6 Performance Test for Kafka Consumer
 *
 * This script tests the performance of consuming messages from a Kafka topic. It is designed
 * to work as part of a consumer group.
 *
 * References:
 * - https://k6.io/docs/javascript-api/k6-x-kafka/reader/
 * - https://romanglushach.medium.com/scaling-kafka-with-confidence-load-and-stress-testing-your-producers-and-consumers-with-k6-3f4b86d3da0d
 *
 * Prerequisites:
 * 1. A custom k6 build with the xk6-kafka extension.
 *    (Build with: xk6 build --with github.com/mostafa/xk6-kafka@latest)
 * 2. A Kafka topic with messages to consume. You can use producer.js to create them.
 *
 * How to run:
 * KAFKA_BROKERS=localhost:9092 KAFKA_TOPIC=my-test-topic ./k6 run consumer.js
 *
 * Note on VUs and Partitions:
 * For optimal performance testing, the number of VUs should be equal to the number of
 * partitions in the Kafka topic. This ensures that each consumer VU is assigned its own
 * partition and you are testing the maximum parallel throughput of the consumer group.
 */

import { check, sleep } from 'k6';
import { Reader } from 'k6/x/kafka';
import { Counter } from 'k6/metrics';

// --- Configuration ---
const KAFKA_BROKERS = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');
const KAFKA_TOPIC = process.env.KAFKA_TOPIC || 'my-test-topic';
// A unique group ID is essential for consumer groups.
const KAFKA_GROUP_ID = process.env.KAFKA_GROUP_ID || 'k6-consumer-group';
const CONSUME_TIMEOUT_MS = 5000; // How long to wait for messages before timing out.

// --- k6 Load Profile ---
export const options = {
  scenarios: {
    consumer_scenario: {
      executor: 'per-vu-iterations',
      vus: 3, // Adjust this to match the number of partitions for the topic
      iterations: 100, // Each VU will attempt to read 100 batches of messages
      maxDuration: '2m',
    },
  },
  thresholds: {
    // 99% of read operations should be below 1.5 seconds.
    'kafka_reader_read_seconds': ['p(99)<1.5'],
    // No more than 1% of read attempts should result in an error.
    'kafka_reader_error_count': { threshold: 'rate < 0.01', abortOnFail: true },
    // Ensure we are actually consuming messages.
    'kafka_messages_read_count': ['count > 0'],
  },
};

// --- Kafka Reader Initialization ---
// Create the reader in the init context.
const reader = new Reader({
  brokers: KAFKA_BROKERS,
  topic: KAFKA_TOPIC,
  groupID: KAFKA_GROUP_ID,
  // Increase queue capacity for higher throughput scenarios.
  queueCapacity: 1000,
});

// Custom metrics
const consumedMessages = new Counter('kafka_messages_read_count');
const consumedBytes = new Counter('kafka_consumed_bytes');

/**
 * Main test function executed by each Virtual User.
 */
export default function () {
  // Consume a batch of messages. The 'limit' parameter controls the max size of the batch.
  const messages = reader.consume({ limit: 10, timeout: CONSUME_TIMEOUT_MS });

  check(messages, {
    'messages were consumed': (msgs) => msgs.length > 0,
    'consumption did not time out': (msgs) => msgs.length > 0,
  });

  if (messages.length > 0) {
    // Add to custom counters
    consumedMessages.add(messages.length);
    const bytes = messages.reduce((acc, msg) => acc + (msg.key.length || 0) + (msg.value.length || 0), 0);
    consumedBytes.add(bytes);

    // Optional: Log the content of the first message in the batch for debugging
    // console.log(`VU ${__VU} consumed message with key: ${messages[0].key}`);
  } else {
    // This indicates that consume() timed out waiting for messages.
    // It's not necessarily an error, could just be that the topic is empty.
    sleep(1); // Wait before trying again.
  }
}

/**
 * Teardown function executed once at the end of the test.
 */
export function teardown(data) {
  // Gracefully close the Kafka reader connection.
  reader.close();
  console.log(`Test finished. Consumed messages from topic: ${KAFKA_TOPIC} with group ID: ${KAFKA_GROUP_ID}`);
}
