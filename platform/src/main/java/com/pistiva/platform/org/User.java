package com.pistiva.platform.org;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "users")
public class User {

    @Id
    private UUID id;
    private String email;
    @Column(name = "password_hash")
    private String passwordHash;
    @Column(name = "platform_admin")
    private boolean platformAdmin;
    @Column(name = "created_at")
    private Instant createdAt;

    protected User() {
    }

    public User(String email, String passwordHash, boolean platformAdmin) {
        this.id = UUID.randomUUID();
        this.email = email;
        this.passwordHash = passwordHash;
        this.platformAdmin = platformAdmin;
        this.createdAt = Instant.now();
    }

    public UUID getId() { return id; }
    public String getEmail() { return email; }
    public String getPasswordHash() { return passwordHash; }
    public boolean isPlatformAdmin() { return platformAdmin; }
    public Instant getCreatedAt() { return createdAt; }
}
