/**
 * k6 Performance Test for Kafka Producer
 *
 * This script tests the performance of producing messages to a Kafka topic. It is designed
 * to be configurable and follows best practices outlined in community articles.
 *
 * References:
 * - https://dev.to/cheviana/performance-testing-kafka-server-using-xk6-kafka-lh4
 * - https://romanglushach.medium.com/scaling-kafka-with-confidence-load-and-stress-testing-your-producers-and-consumers-with-k6-3f4b86d3da0d
 *
 * Prerequisites:
 * 1. A custom k6 build with the xk6-kafka extension.
 *    (Build with: xk6 build --with github.com/mostafa/xk6-kafka@latest)
 * 2. Kafka brokers accessible from the machine running k6.
 *
 * How to run:
 * KAFKA_BROKERS=localhost:9092 KAFKA_TOPIC=my-test-topic ./k6 run producer.js
 */

import { check, sleep } from 'k6';
import { Writer } from 'k6/x/kafka';
import { Trend, Counter } from 'k6/metrics';
import { randomString } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

// --- Configuration ---
// Use environment variables for flexibility or fallback to defaults.
const KAFKA_BROKERS = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');
const KAFKA_TOPIC = process.env.KAFKA_TOPIC || 'my-test-topic';
const MESSAGES_PER_ITERATION = 10;
const MESSAGE_BODY_SIZE = 100; // Size of the random string in the message body.

// --- k6 Load Profile ---
export const options = {
  scenarios: {
    producer_scenario: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '15s', target: 10 }, // Ramp up to 10 Virtual Users over 15s
        { duration: '60s', target: 10 }, // Stay at 10 VUs for 60s to measure steady state
        { duration: '10s', target: 0 },  // Ramp down
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    // 99% of write requests should be below 1 second.
    'kafka_writer_write_seconds': ['p(99)<1'],
    // No more than 0.1% of write attempts should fail.
    'kafka_writer_error_count': ['count<1'],
    // Ensure a minimum throughput of 100 messages/sec. Adjust as needed.
    'kafka_writer_write_count': ['count/s > 100'],
  },
};

// --- Kafka Writer Initialization ---
// Create the writer in the init context. This is a performance best practice.
const writer = new Writer({
  brokers: KAFKA_BROKERS,
  topic: KAFKA_TOPIC,
  // Auto-create topic if it doesn't exist. Set to 'false' in production.
  autoCreateTopic: true,
});

// Custom metrics to track the volume of data produced.
const producedBytes = new Counter('kafka_produced_bytes');

/**
 * Main test function executed by each Virtual User.
 */
export default function () {
  const messages = [];

  for (let i = 0; i < MESSAGES_PER_ITERATION; i++) {
    const messageKey = `key-${__VU}-${__ITER}-${i}`;
    const messageValue = JSON.stringify({
      vu: __VU,
      iter: __ITER,
      sequence: i,
      timestamp: new Date().toISOString(),
      data: randomString(MESSAGE_BODY_SIZE),
    });

    messages.push({
      key: messageKey,
      value: messageValue,
    });
  }

  try {
    // Produce a batch of messages to Kafka
    writer.produce({ messages });

    // Track the number of bytes produced
    const bytes = messages.reduce((acc, msg) => acc + (msg.key.length || 0) + (msg.value.length || 0), 0);
    producedBytes.add(bytes);

  } catch (error) {
    // This block will be executed if the write operation fails.
    console.error(`VU ${__VU} failed to produce messages: ${error}`);
  }

  // A short sleep to control the message rate per VU.
  sleep(1);
}

/**
 * Teardown function executed once at the end of the test.
 */
export function teardown(data) {
  // Gracefully close the Kafka writer connection.
  writer.close();
  console.log(`Test finished. Produced messages to topic: ${KAFKA_TOPIC}`);
}
