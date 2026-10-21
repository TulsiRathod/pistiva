package com.pistiva.platform.task;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.IdClass;
import jakarta.persistence.Table;

import java.io.Serializable;
import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

/** Hashes and both signatures for one message round of a task. Payloads are never stored. */
@Entity
@Table(name = "task_receipts")
@IdClass(TaskReceipt.Key.class)
public class TaskReceipt {

    public static class Key implements Serializable {
        private UUID taskId;
        private int round;

        public Key() {
        }

        public Key(UUID taskId, int round) {
            this.taskId = taskId;
            this.round = round;
        }

        @Override
        public boolean equals(Object o) {
            return o instanceof Key k && k.round == round && Objects.equals(k.taskId, taskId);
        }

        @Override
        public int hashCode() {
            return Objects.hash(taskId, round);
        }
    }

    @Id
    @Column(name = "task_id")
    private UUID taskId;
    @Id
    private int round;
    @Column(name = "grant_id")
    private UUID grantId;
    private String state;
    @Column(name = "request_hash")
    private String requestHash;
    @Column(name = "response_hash")
    private String responseHash;
    @Column(name = "provider_kid")
    private String providerKid;
    @Column(name = "provider_signature")
    private String providerSignature;
    @Column(name = "requester_kid")
    private String requesterKid;
    @Column(name = "requester_signature")
    private String requesterSignature;
    @Column(name = "recorded_at")
    private Instant recordedAt;

    protected TaskReceipt() {
    }

    public TaskReceipt(UUID taskId, int round, UUID grantId, String state, String requestHash, String responseHash,
                       String providerKid, String providerSignature, String requesterKid, String requesterSignature) {
        this.taskId = taskId;
        this.round = round;
        this.grantId = grantId;
        this.state = state;
        this.requestHash = requestHash;
        this.responseHash = responseHash;
        this.providerKid = providerKid;
        this.providerSignature = providerSignature;
        this.requesterKid = requesterKid;
        this.requesterSignature = requesterSignature;
        this.recordedAt = Instant.now();
    }

    public UUID getTaskId() { return taskId; }
    public int getRound() { return round; }
    public UUID getGrantId() { return grantId; }
    public String getState() { return state; }
    public String getRequestHash() { return requestHash; }
    public String getResponseHash() { return responseHash; }
    public Instant getRecordedAt() { return recordedAt; }
}
