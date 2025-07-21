/**
 * k6 Performance Test for Kafka Producer (Improved)
 */

import { check, sleep } from 'k6';
import { Writer, Connection, SchemaRegistry, SCHEMA_TYPE_STRING } from 'k6/x/kafka';
import { Counter } from 'k6/metrics';
import faker from 'k6/x/faker';

// --- Configuration ---
const KAFKA_BROKERS = (__ENV.KAFKA_BROKERS || 'localhost:9094').split(',');
const KAFKA_TOPIC = __ENV.KAFKA_TOPIC || 'my-test-topic'; // Match consumer default
const MESSAGES_PER_ITERATION = 10;
const DELETE_TOPIC_ON_TEARDOWN = __ENV.DELETE_TOPIC_ON_TEARDOWN === 'true';

// --- k6 Load Profile ---
export const options = {
  scenarios: {
    producer_scenario: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '15s', target: 10 },
        { duration: '60s', target: 10 },
        { duration: '10s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    'kafka_writer_write_seconds': ['p(99)<1'],
    'kafka_writer_error_count': ['count<10'], // Allow some errors but not too many
    'kafka_produced_messages': ['count>0'], // Ensure we produce some messages
  },
};

// --- Kafka Initialization ---
const connection = new Connection({ address: KAFKA_BROKERS[0] });
const writer = new Writer({ brokers: KAFKA_BROKERS, topic: KAFKA_TOPIC });
const schemaRegistry = new SchemaRegistry();

const producedBytes = new Counter('kafka_produced_bytes');
const producedMessages = new Counter('kafka_produced_messages');

// Setup function - runs once before all VUs start
export function setup() {
  try {
    // Create topic with proper configuration
    connection.createTopic({ 
      topic: KAFKA_TOPIC,
      numPartitions: 3, // Match consumer VU count
      replicationFactor: 1
    });
    console.log(`Topic '${KAFKA_TOPIC}' created or already exists`);
    
    // Give topic creation time to propagate
    sleep(2);
  } catch (error) {
    console.warn(`Topic creation warning (may already exist): ${error}`);
  }
}

/**
 * Main test function executed by each Virtual User.
 */
export default function () {
  const messages = [];

  for (let i = 0; i < MESSAGES_PER_ITERATION; i++) {
    const messageKey = `${__VU}-${__ITER}-${i}`;
    const messageValue = JSON.stringify({
      vu: __VU,
      iter: __ITER,
      sequence: i,
      timestamp: new Date().toISOString(),
      user: {
        name: faker.person.firstName(),
        email: faker.person.email(),
        address: faker.address.address(),
      },
    });

    messages.push({
      key: schemaRegistry.serialize({
        data: messageKey,
        schemaType: SCHEMA_TYPE_STRING,
      }),
      value: schemaRegistry.serialize({
        data: messageValue,
        schemaType: SCHEMA_TYPE_STRING,
      }),
    });
  }

  try {
    writer.produce({ messages });

    const bytes = messages.reduce((acc, msg) => acc + msg.key.length + msg.value.length, 0);
    producedBytes.add(bytes);
    producedMessages.add(messages.length);

    check(null, {
      'messages produced successfully': () => true,
    });

  } catch (error) {
    console.error(`VU ${__VU} failed to produce messages: ${error}`);
    check(null, {
      'messages produced successfully': () => false,
    });
  }

  sleep(1);
}

/**
 * Teardown function executed once at the end of the test.
 */
export function teardown(data) {
  try {
    writer.close();
    
    // Only delete topic if explicitly requested
    if (DELETE_TOPIC_ON_TEARDOWN) {
      connection.deleteTopic(KAFKA_TOPIC);
      console.log(`Topic '${KAFKA_TOPIC}' deleted.`);
    } else {
      console.log(`Topic '${KAFKA_TOPIC}' preserved for consumers.`);
    }
    
    connection.close();
    console.log('Producer test finished.');
  } catch (error) {
    console.error(`Teardown error: ${error}`);
  }
}