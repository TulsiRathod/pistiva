package com.pistiva.platform.org;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "organizations")
public class Organization {

    public enum VerificationStatus { PENDING, VERIFIED }

    public enum Status { ACTIVE, SUSPENDED }

    @Id
    private UUID id;
    private String name;
    private String domain;
    @Enumerated(EnumType.STRING)
    @Column(name = "verification_status")
    private VerificationStatus verificationStatus;
    @Column(name = "verification_token")
    private String verificationToken;
    @Enumerated(EnumType.STRING)
    private Status status;
    @Column(name = "created_at")
    private Instant createdAt;

    protected Organization() {
    }

    public Organization(String name, String domain, String verificationToken) {
        this.id = UUID.randomUUID();
        this.name = name;
        this.domain = domain;
        this.verificationToken = verificationToken;
        this.verificationStatus = VerificationStatus.PENDING;
        this.status = Status.ACTIVE;
        this.createdAt = Instant.now();
    }

    /** Only a verified, active organization may publish agents to discovery or obtain grants. */
    public boolean isTrusted() {
        return verificationStatus == VerificationStatus.VERIFIED && status == Status.ACTIVE;
    }

    public UUID getId() { return id; }
    public String getName() { return name; }
    public String getDomain() { return domain; }
    public VerificationStatus getVerificationStatus() { return verificationStatus; }
    public String getVerificationToken() { return verificationToken; }
    public Status getStatus() { return status; }
    public Instant getCreatedAt() { return createdAt; }

    public void markVerified() { this.verificationStatus = VerificationStatus.VERIFIED; }
    public void setStatus(Status status) { this.status = status; }
}
