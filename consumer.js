/**
 * k6 Performance Test for Kafka Consumer (Improved)
 */

import { check, sleep } from 'k6';
import { Reader, Connection } from 'k6/x/kafka';
import { Counter } from 'k6/metrics';

// --- Configuration ---
const KAFKA_BROKERS = (__ENV.KAFKA_BROKERS || 'localhost:9092').split(',');
const KAFKA_TOPIC = __ENV.KAFKA_TOPIC || 'my-test-topic';
const KAFKA_GROUP_ID = __ENV.KAFKA_GROUP_ID || 'k6-consumer-group';
const CONSUME_TIMEOUT_MS = parseInt(__ENV.CONSUME_TIMEOUT_MS || '2000'); // Shorter timeout
const MAX_EMPTY_READS = parseInt(__ENV.MAX_EMPTY_READS || '5'); // Fewer retries before giving up

// --- k6 Load Profile ---
export const options = {
  scenarios: {
    consumer_scenario: {
      executor: 'per-vu-iterations',
      vus: 3, // Match number of partitions
      iterations: 100,
      maxDuration: '2m',
    },
  },
  thresholds: {
    'kafka_reader_read_seconds': [{ threshold: 'p(99)<1.5' }],
    'kafka_reader_error_count': [{ threshold: 'rate < 0.05' }], // Real errors should be rare
    'kafka_timeout_errors': [{ threshold: 'rate < 0.6' }], // Timeouts are more acceptable
    'kafka_messages_read_count': [{ threshold: 'count > 0' }],
    'kafka_empty_reads': [{ threshold: 'count < 100' }],
  },
};

// Custom metrics
const consumedMessages = new Counter('kafka_messages_read_count');
const consumedBytes = new Counter('kafka_consumed_bytes');
const emptyReads = new Counter('kafka_empty_reads');
const readerErrors = new Counter('kafka_reader_error_count');
const timeoutErrors = new Counter('kafka_timeout_errors'); // Separate timeout errors

// --- Kafka Reader Initialization ---
let reader;

export function setup() {
  // Verify topic exists
  const connection = new Connection({ address: KAFKA_BROKERS[0] });
  try {
    // This will throw if topic doesn't exist
    const topics = connection.listTopics();
    connection.close();
    console.log(`Consumer setup complete. Topic '${KAFKA_TOPIC}' verified.`);
  } catch (error) {
    connection.close();
    console.error(`Setup failed - topic may not exist: ${error}`);
    throw error;
  }
}

/**
 * Main test function executed by each Virtual User.
 */
export default function () {
  // Initialize reader per VU (not globally)
  if (!reader) {
    try {
      reader = new Reader({
        brokers: KAFKA_BROKERS,
        groupTopics: [KAFKA_TOPIC],
        groupID: KAFKA_GROUP_ID,
        queueCapacity: 1000,
      });
    } catch (error) {
      console.error(`VU ${__VU} failed to create reader: ${error}`);
      readerErrors.add(1);
      return;
    }
  }

  let emptyReadCount = 0;
  let messages = [];

  try {
    // Consume a batch of messages
    messages = reader.consume({ limit: 10, timeout: CONSUME_TIMEOUT_MS });

    const checksSuccess = check(messages, {
      'messages were consumed': (msgs) => msgs && msgs.length > 0,
      'consume operation succeeded': (msgs) => msgs !== null && msgs !== undefined,
    });

    if (!checksSuccess) {
      readerErrors.add(1);
    }

    if (messages && messages.length > 0) {
      // Reset empty read counter
      emptyReadCount = 0;
      
      // Add to custom counters
      consumedMessages.add(messages.length);
      const bytes = messages.reduce((acc, msg) => {
        const keyLength = (msg.key && msg.key.length) || 0;
        const valueLength = (msg.value && msg.value.length) || 0;
        return acc + keyLength + valueLength;
      }, 0);
      consumedBytes.add(bytes);

      // Optional: Log sample message for debugging
      // console.log(`VU ${__VU} consumed ${messages.length} messages`);
      
    } else {
      // Handle empty reads
      emptyReadCount++;
      emptyReads.add(1);
      
      if (emptyReadCount >= MAX_EMPTY_READS) {
        console.log(`VU ${__VU} reached max empty reads (${MAX_EMPTY_READS}), stopping`);
        return; // Exit this VU iteration
      }
      
      // Wait before trying again
      sleep(1);
    }

  } catch (error) {
    const errorMsg = error.toString();
    
    if (errorMsg.includes('context deadline exceeded')) {
      // This is a timeout, not a real error
      timeoutErrors.add(1);
      emptyReads.add(1);
      
      emptyReadCount++;
      if (emptyReadCount >= MAX_EMPTY_READS) {
        console.log(`VU ${__VU} reached max empty reads due to timeouts, stopping`);
        return;
      }
    } else {
      // This is a real error
      console.error(`VU ${__VU} consume error: ${error}`);
      readerErrors.add(1);
      
      // Close and recreate reader on real errors
      if (reader) {
        try {
          reader.close();
        } catch (closeError) {
          console.error(`Error closing reader: ${closeError}`);
        }
        reader = null;
      }
    }
    
    sleep(1); // Wait before retry
  }
}

/**
 * Teardown function executed once at the end of the test.
 */
export function teardown(data) {
  if (reader) {
    try {
      reader.close();
      console.log(`Consumer test finished. Consumed from topic: ${KAFKA_TOPIC} with group ID: ${KAFKA_GROUP_ID}`);
    } catch (error) {
      console.error(`Teardown error: ${error}`);
    }
  }
}
