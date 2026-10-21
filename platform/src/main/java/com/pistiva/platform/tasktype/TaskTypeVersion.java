package com.pistiva.platform.tasktype;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.IdClass;
import jakarta.persistence.Table;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.io.Serializable;
import java.time.Instant;
import java.util.Objects;

/** An immutable contract version: once published, its schemas never change; a change is a new version. */
@Entity
@Table(name = "task_type_versions")
@IdClass(TaskTypeVersion.Key.class)
public class TaskTypeVersion {

    public enum Direction { requester_to_provider, provider_to_requester }

    public enum Cardinality { one_to_one, one_to_many }

    public static class Key implements Serializable {
        private String name;
        private int version;

        public Key() {
        }

        public Key(String name, int version) {
            this.name = name;
            this.version = version;
        }

        @Override
        public boolean equals(Object o) {
            return o instanceof Key k && k.version == version && Objects.equals(k.name, name);
        }

        @Override
        public int hashCode() {
            return Objects.hash(name, version);
        }
    }

    @Id
    private String name;
    @Id
    private int version;
    @Enumerated(EnumType.STRING)
    private Direction direction;
    @Enumerated(EnumType.STRING)
    private Cardinality cardinality;
    private String handler;
    @JdbcTypeCode(SqlTypes.JSON)
    private String messages;
    @Column(name = "created_at")
    private Instant createdAt;

    protected TaskTypeVersion() {
    }

    public TaskTypeVersion(String name, int version, Direction direction, Cardinality cardinality, String handler, String messages) {
        this.name = name;
        this.version = version;
        this.direction = direction;
        this.cardinality = cardinality;
        this.handler = handler;
        this.messages = messages;
        this.createdAt = Instant.now();
    }

    public String getName() { return name; }
    public int getVersion() { return version; }
    public Direction getDirection() { return direction; }
    public Cardinality getCardinality() { return cardinality; }
    public String getHandler() { return handler; }
    public String getMessages() { return messages; }
    public Instant getCreatedAt() { return createdAt; }
}
