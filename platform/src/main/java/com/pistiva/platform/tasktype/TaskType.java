package com.pistiva.platform.tasktype;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.Instant;

@Entity
@Table(name = "task_types")
public class TaskType {

    @Id
    private String name;
    private String pack;
    private String description;
    private boolean extension;
    @Column(name = "created_at")
    private Instant createdAt;

    protected TaskType() {
    }

    public TaskType(String name, String pack, String description, boolean extension) {
        this.name = name;
        this.pack = pack;
        this.description = description;
        this.extension = extension;
        this.createdAt = Instant.now();
    }

    public String getName() { return name; }
    public String getPack() { return pack; }
    public String getDescription() { return description; }
    public boolean isExtension() { return extension; }
    public Instant getCreatedAt() { return createdAt; }
}
