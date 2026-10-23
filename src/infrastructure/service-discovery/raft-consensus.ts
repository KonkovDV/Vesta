/**
 * Raft Consensus Service
 * Implements the Raft consensus algorithm for distributed state machine replication.
 * Layer: Infrastructure
 *
 * Features:
 * - Leader election with randomized timeouts
 * - Log replication for service registry state
 * - Automatic failover on leader failure
 * - Split-brain prevention through majority voting
 */

import { EventEmitter } from 'events';
import type { IStructuredLogger } from '../../core/logging/IStructuredLogger';

/**
 * Raft node states
 */
export type RaftNodeState = 'FOLLOWER' | 'CANDIDATE' | 'LEADER';

/**
 * Raft log entry
 */
export interface RaftLogEntry<T = unknown> {
  index: number;
  term: number;
  command: T;
  timestamp: number;
}

/**
 * Raft node configuration
 */
export interface RaftNodeConfig {
  nodeId: string;
  peers: string[];
  heartbeatIntervalMs: number;
  minElectionTimeoutMs: number;
  maxElectionTimeoutMs: number;
  maxLogEntriesPerRequest: number;
}

/**
 * Raft vote request
 */
export interface RequestVoteRequest {
  term: number;
  candidateId: string;
  lastLogIndex: number;
  lastLogTerm: number;
}

/**
 * Raft vote response
 */
export interface RequestVoteResponse {
  term: number;
  voteGranted: boolean;
  voterId: string;
}

/**
 * Raft append entries request (heartbeat or log replication)
 */
export interface AppendEntriesRequest<T = unknown> {
  term: number;
  leaderId: string;
  prevLogIndex: number;
  prevLogTerm: number;
  entries: RaftLogEntry<T>[];
  leaderCommit: number;
}

/**
 * Raft append entries response
 */
export interface AppendEntriesResponse {
  term: number;
  success: boolean;
  nodeId: string;
  matchIndex: number;
  conflictIndex?: number;
}

/**
 * Raft state snapshot
 */
export interface RaftStateSnapshot<T = unknown> {
  lastIncludedIndex: number;
  lastIncludedTerm: number;
  data: T;
}

/**
 * Commit event emitted when entries are committed
 */
export interface CommitEvent<T = unknown> {
  index: number;
  term: number;
  command: T;
}

/**
 * Raft transport interface for network communication
 */
export interface IRaftTransport {
  sendRequestVote(targetNodeId: string, request: RequestVoteRequest): Promise<RequestVoteResponse>;
  sendAppendEntries<T>(targetNodeId: string, request: AppendEntriesRequest<T>): Promise<AppendEntriesResponse>;
  broadcastRequestVote(request: RequestVoteRequest): Promise<RequestVoteResponse[]>;
  broadcastAppendEntries<T>(request: AppendEntriesRequest<T>): Promise<AppendEntriesResponse[]>;
}

/**
 * Raft consensus service implementation
 */
export class RaftConsensusService<T = unknown> extends EventEmitter {
  private state: RaftNodeState = 'FOLLOWER';
  private currentTerm = 0;
  private votedFor: string | null = null;
  private log: RaftLogEntry<T>[] = [];
  private commitIndex = 0;
  private lastApplied = 0;

  // Leader state (volatile)
  private nextIndex: Map<string, number> = new Map();
  private matchIndex: Map<string, number> = new Map();

  // Timers
  private electionTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  // State
  private running = false;
  private leaderId: string | null = null;
  private votesReceived = new Set<string>();

  constructor(
    private config: RaftNodeConfig,
    private transport: IRaftTransport,
    private readonly logger?: IStructuredLogger
  ) {
    super();
  }

  /**
   * Start the Raft node
   */
  async start(): Promise<void> {
    if (this.running) return;

    this.running = true;
    this.resetElectionTimer();

    this.emit('started', { nodeId: this.config.nodeId });
  }

  /**
   * Stop the Raft node
   */
  async stop(): Promise<void> {
    this.running = false;
    this.clearTimers();
    this.emit('stopped', { nodeId: this.config.nodeId });
  }

  /**
   * Check if this node is the leader
   */
  isLeader(): boolean {
    return this.state === 'LEADER';
  }

  /**
   * Get current leader ID
   */
  getLeaderId(): string | null {
    return this.leaderId;
  }

  /**
   * Get current term
   */
  getCurrentTerm(): number {
    return this.currentTerm;
  }

  /**
   * Get current state
   */
  getState(): RaftNodeState {
    return this.state;
  }

  /**
   * Get log entries
   */
  getLog(): ReadonlyArray<RaftLogEntry<T>> {
    return [...this.log];
  }

  /**
   * Get commit index
   */
  getCommitIndex(): number {
    return this.commitIndex;
  }

  /**
   * Propose a new command (only leader can propose)
   */
  async propose(command: T): Promise<number> {
    if (this.state !== 'LEADER') {
      throw new Error('Only leader can propose commands');
    }

    const entry: RaftLogEntry<T> = {
      index: this.log.length + 1,
      term: this.currentTerm,
      command,
      timestamp: Date.now(),
    };

    this.log.push(entry);
    this.emit('logAppended', { entry });

    // Replicate to followers immediately
    await this.replicateLog();

    return entry.index;
  }

  /**
   * Handle request vote RPC
   */
  async handleRequestVote(request: RequestVoteRequest): Promise<RequestVoteResponse> {
    // Reply false if term < currentTerm
    if (request.term < this.currentTerm) {
      return {
        term: this.currentTerm,
        voteGranted: false,
        voterId: this.config.nodeId,
      };
    }

    // If term > currentTerm, update currentTerm and convert to follower
    if (request.term > this.currentTerm) {
      this.currentTerm = request.term;
      this.convertToFollower();
    }

    // Check if we can grant vote
    const lastLog = this.getLastLogEntry();
    const logOk =
      request.lastLogTerm > lastLog.term ||
      (request.lastLogTerm === lastLog.term && request.lastLogIndex >= lastLog.index);

    const canGrantVote =
      (this.votedFor === null || this.votedFor === request.candidateId) && logOk;

    if (canGrantVote) {
      this.votedFor = request.candidateId;
      this.resetElectionTimer();
    }

    return {
      term: this.currentTerm,
      voteGranted: canGrantVote,
      voterId: this.config.nodeId,
    };
  }

  /**
   * Handle append entries RPC
   */
  async handleAppendEntries(request: AppendEntriesRequest<T>): Promise<AppendEntriesResponse> {
    // Reply false if term < currentTerm
    if (request.term < this.currentTerm) {
      return {
        term: this.currentTerm,
        success: false,
        nodeId: this.config.nodeId,
        matchIndex: 0,
      };
    }

    // Update leader ID
    this.leaderId = request.leaderId;

    // If term > currentTerm, update and convert to follower
    if (request.term > this.currentTerm) {
      this.currentTerm = request.term;
      this.convertToFollower();
    }

    // Reset election timer on valid leader contact
    this.resetElectionTimer();

    // Reply false if log doesn't contain entry at prevLogIndex with prevLogTerm
    if (request.prevLogIndex > 0) {
      const prevEntry = this.log[request.prevLogIndex - 1];
      if (!prevEntry || prevEntry.term !== request.prevLogTerm) {
        // Find conflict index
        let conflictIndex = request.prevLogIndex;
        while (conflictIndex > 1 && this.log[conflictIndex - 2]?.term === request.prevLogTerm) {
          conflictIndex--;
        }

        return {
          term: this.currentTerm,
          success: false,
          nodeId: this.config.nodeId,
          matchIndex: 0,
          conflictIndex,
        };
      }
    }

    // Process entries
    for (const entry of request.entries) {
      const existingEntry = this.log[entry.index - 1];

      if (existingEntry) {
        // If existing entry conflicts with new one, delete it and all that follow
        if (existingEntry.term !== entry.term) {
          this.log = this.log.slice(0, entry.index - 1);
          this.log.push(entry);
        }
        // Otherwise, entry already exists, skip
      } else {
        this.log.push(entry);
      }
    }

    // Update commit index
    if (request.leaderCommit > this.commitIndex) {
      this.commitIndex = Math.min(request.leaderCommit, this.log.length);
      await this.applyCommittedEntries();
    }

    this.emit('appendEntriesReceived', { request, newCommitIndex: this.commitIndex });

    return {
      term: this.currentTerm,
      success: true,
      nodeId: this.config.nodeId,
      matchIndex: this.log.length,
    };
  }

  /**
   * Convert to candidate and start election
   */
  private async convertToCandidate(): Promise<void> {
    this.state = 'CANDIDATE';
    this.currentTerm++;
    this.votedFor = this.config.nodeId;
    this.votesReceived = new Set([this.config.nodeId]);

    this.emit('becameCandidate', { term: this.currentTerm });

    const lastLog = this.getLastLogEntry();
    const request: RequestVoteRequest = {
      term: this.currentTerm,
      candidateId: this.config.nodeId,
      lastLogIndex: lastLog.index,
      lastLogTerm: lastLog.term,
    };

    try {
      const responses = await this.transport.broadcastRequestVote(request);

      for (const response of responses) {
        if (response.term > this.currentTerm) {
          this.currentTerm = response.term;
          this.convertToFollower();
          return;
        }

        if (response.voteGranted) {
          this.votesReceived.add(response.voterId);
        }
      }

      // Check if we have majority
      const majority = Math.floor((this.config.peers.length + 1) / 2) + 1;
      if (this.votesReceived.size >= majority && this.state === 'CANDIDATE') {
        this.convertToLeader();
      }
    } catch (error) {
      this.logger?.error(`[Raft] ${this.config.nodeId} election error`, { error: String(error) });
      this.emit('electionError', { error });
    }
  }

  /**
   * Convert to leader
   */
  private convertToLeader(): void {
    this.state = 'LEADER';
    this.leaderId = this.config.nodeId;

    // Initialize leader state
    const nextIdx = this.log.length + 1;
    for (const peer of this.config.peers) {
      this.nextIndex.set(peer, nextIdx);
      this.matchIndex.set(peer, 0);
    }

    this.emit('becameLeader', { term: this.currentTerm });

    // Send immediate heartbeat
    void this.sendHeartbeat();

    // Start heartbeat timer
    this.startHeartbeatTimer();
  }

  /**
   * Convert to follower
   */
  private convertToFollower(): void {
    this.state = 'FOLLOWER';
    this.votedFor = null;
    this.clearHeartbeatTimer();
    this.resetElectionTimer();

    this.emit('becameFollower', { term: this.currentTerm });
  }

  /**
   * Send heartbeat to all peers
   */
  private async sendHeartbeat(): Promise<void> {
    if (this.state !== 'LEADER') return;

    const request: AppendEntriesRequest<T> = {
      term: this.currentTerm,
      leaderId: this.config.nodeId,
      prevLogIndex: this.log.length,
      prevLogTerm: this.log.length > 0 ? this.log[this.log.length - 1].term : 0,
      entries: [],
      leaderCommit: this.commitIndex,
    };

    try {
      const responses = await this.transport.broadcastAppendEntries(request);

      for (const response of responses) {
        if (response.term > this.currentTerm) {
          this.currentTerm = response.term;
          this.convertToFollower();
          return;
        }
      }
    } catch (error) {
      this.emit('heartbeatError', { error });
    }
  }

  /**
   * Replicate log entries to followers
   */
  private async replicateLog(): Promise<void> {
    if (this.state !== 'LEADER') return;

    const promises: Promise<void>[] = [];

    for (const peer of this.config.peers) {
      const nextIdx = this.nextIndex.get(peer) || 1;
      const prevLogIndex = nextIdx - 1;
      const prevLogTerm = prevLogIndex > 0 ? this.log[prevLogIndex - 1]?.term || 0 : 0;

      const entries = this.log.slice(nextIdx - 1, nextIdx - 1 + this.config.maxLogEntriesPerRequest);

      const request: AppendEntriesRequest<T> = {
        term: this.currentTerm,
        leaderId: this.config.nodeId,
        prevLogIndex,
        prevLogTerm,
        entries,
        leaderCommit: this.commitIndex,
      };

      promises.push(
        this.transport
          .sendAppendEntries(peer, request)
          .then((response) => {
            if (response.term > this.currentTerm) {
              this.currentTerm = response.term;
              this.convertToFollower();
              return;
            }

            if (response.success) {
              this.matchIndex.set(peer, response.matchIndex);
              this.nextIndex.set(peer, response.matchIndex + 1);
            } else {
              // Decrement nextIndex and retry
              const currentNextIndex = this.nextIndex.get(peer) || 1;
              this.nextIndex.set(peer, Math.max(1, response.conflictIndex || currentNextIndex - 1));
            }
          })
          .catch((error) => {
            this.emit('replicationError', { peer, error });
          })
      );
    }

    await Promise.allSettled(promises);

    // Update commit index for entries from current term
    for (let idx = this.commitIndex + 1; idx <= this.log.length; idx++) {
      const entry = this.log[idx - 1];
      if (entry.term !== this.currentTerm) continue;

      let replicatedCount = 1; // Leader has it
      for (const peer of this.config.peers) {
        if ((this.matchIndex.get(peer) || 0) >= idx) {
          replicatedCount++;
        }
      }

      const majority = Math.floor((this.config.peers.length + 1) / 2) + 1;
      if (replicatedCount >= majority) {
        this.commitIndex = idx;
      } else {
        break;
      }
    }

    await this.applyCommittedEntries();
  }

  /**
   * Apply committed entries to state machine
   */
  private async applyCommittedEntries(): Promise<void> {
    while (this.lastApplied < this.commitIndex) {
      this.lastApplied++;
      const entry = this.log[this.lastApplied - 1];

      const commitEvent: CommitEvent<T> = {
        index: entry.index,
        term: entry.term,
        command: entry.command,
      };

      this.emit('committed', commitEvent);
    }
  }

  /**
   * Get last log entry info
   */
  private getLastLogEntry(): { index: number; term: number } {
    if (this.log.length === 0) {
      return { index: 0, term: 0 };
    }
    const entry = this.log[this.log.length - 1];
    return { index: entry.index, term: entry.term };
  }

  /**
   * Reset election timer
   */
  private resetElectionTimer(): void {
    this.clearElectionTimer();

    const timeout =
      this.config.minElectionTimeoutMs +
      Math.random() * (this.config.maxElectionTimeoutMs - this.config.minElectionTimeoutMs);

    this.electionTimer = setTimeout(() => {
      if (this.running) {
        void this.convertToCandidate();
      }
    }, timeout);
  }

  /**
   * Start heartbeat timer
   */
  private startHeartbeatTimer(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.running && this.state === 'LEADER') {
        void this.sendHeartbeat();
      }
    }, this.config.heartbeatIntervalMs);
  }

  /**
   * Clear all timers
   */
  private clearTimers(): void {
    this.clearElectionTimer();
    this.clearHeartbeatTimer();
  }

  /**
   * Clear election timer
   */
  private clearElectionTimer(): void {
    if (this.electionTimer) {
      clearTimeout(this.electionTimer);
      this.electionTimer = null;
    }
  }

  /**
   * Clear heartbeat timer
   */
  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
