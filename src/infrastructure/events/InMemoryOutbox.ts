import {
  IOutbox,
  OutboxMessage,
  PublishResult,
  OutboxStats,
  OutboxStatus,
} from '../../domain/events/outbox.interface';
import { DomainEvent } from '../../domain/events/event-store.interface';
import { IdGenerator } from '../../core/utils/IdGenerator';

function eventWillFail(event: DomainEvent): boolean {
  const eventRecord = event as unknown as Record<string, unknown>;
  const payload = typeof event.payload === 'object' && event.payload !== null
    ? event.payload
    : undefined;
  const data = typeof eventRecord.data === 'object' && eventRecord.data !== null
    ? eventRecord.data as Record<string, unknown>
    : undefined;

  return payload?.willFail === true || data?.willFail === true || eventRecord.willFail === true;
}

/**
 * In-Memory Outbox implementation for testing.
 */
export class InMemoryOutbox implements IOutbox {
  private messages: OutboxMessage[] = [];

  async saveEventsWithOutbox(events: DomainEvent[], transactionId?: string): Promise<OutboxMessage[]> {
    const newMessages: OutboxMessage[] = events.map((event) => ({
      messageId: IdGenerator.generateWithPrefix('msg'),
      event: event,
      status: 'PENDING',
      retryCount: 0,
      createdAt: new Date(),
      eventTimestamp: event.timestamp,
      aggregateVersion: event.aggregateVersion,
      causationId: event.causationId,
      transactionId: transactionId,
      metadata: event.metadata,
    }));

    this.messages.push(...newMessages);
    return newMessages;
  }

  async processPendingMessages(batchSize: number = 100): Promise<PublishResult> {
    const pending = this.messages.filter((m) => m.status === 'PENDING').slice(0, batchSize);
    const publishedMessages: string[] = [];
    
    for (const msg of pending) {
      // Simulate failure if event data has willFail property
      if (eventWillFail(msg.event)) {
        await this.moveToDeadLetterQueue(msg.messageId, 'Simulated failure');
        continue;
      }

      msg.status = 'PUBLISHED';
      msg.publishedAt = new Date();
      publishedMessages.push(msg.messageId);
    }

    return {
      success: true,
      publishedMessages,
      failedMessages: [],
      processingTime: 0,
    };
  }

  async processMessage(messageId: string): Promise<boolean> {
    const msg = this.messages.find((m) => m.messageId === messageId);
    if (!msg) return false;

    msg.status = 'PUBLISHED';
    msg.publishedAt = new Date();
    return true;
  }

  async retryMessage(messageId: string): Promise<boolean> {
    const msg = this.messages.find((m) => m.messageId === messageId);
    if (!msg) return false;

    msg.retryCount++;
    msg.status = 'PENDING'; // Reset to pending for retry
    return true;
  }

  async moveToDeadLetterQueue(messageId: string, reason: string): Promise<void> {
    const msg = this.messages.find((m) => m.messageId === messageId);
    if (!msg) return;

    msg.status = 'DEAD_LETTER';
    msg.lastError = reason;
  }

  async getDeadLetterMessages(limit: number = 100): Promise<OutboxMessage[]> {
    return this.messages.filter((m) => m.status === 'DEAD_LETTER' as OutboxStatus).slice(0, limit);
  }

  async replayDeadLetterMessage(messageId: string): Promise<boolean> {
    const msg = this.messages.find((m) => m.messageId === messageId);
    if (!msg || msg.status !== 'DEAD_LETTER' as OutboxStatus) return false;

    msg.status = 'PENDING';
    msg.retryCount = 0;
    msg.lastError = undefined;
    return true;
  }

  async cleanupOldMessages(retentionPeriodMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - retentionPeriodMs);
    const initialCount = this.messages.length;
    this.messages = this.messages.filter((m) => m.createdAt >= cutoff);
    return initialCount - this.messages.length;
  }

  async startProcessing(): Promise<void> {
    // No-op for in-memory
  }

  async stopProcessing(): Promise<void> {
    // No-op for in-memory
  }

  async getStats(): Promise<OutboxStats> {
    return {
      totalMessages: this.messages.length,
      pendingMessages: this.messages.filter((m) => m.status === 'PENDING').length,
      processingMessages: this.messages.filter((m) => m.status === 'PROCESSING').length,
      publishedMessages: this.messages.filter((m) => m.status === 'PUBLISHED').length,
      failedMessages: this.messages.filter((m) => m.status === 'FAILED').length,
      deadLetterMessages: this.messages.filter((m) => m.status === 'DEAD_LETTER').length,
      averagePublishTime: 0,
      lastMessageAt: this.messages.length > 0 ? this.messages[this.messages.length - 1].createdAt : undefined,
    };
  }

  async isHealthy(): Promise<boolean> {
    return true;
  }

  async initialize(): Promise<void> {
    // No-op
  }

  async close(): Promise<void> {
    this.messages = [];
  }

  // Test helper
  getMessages(): OutboxMessage[] {
    return this.messages;
  }
}
