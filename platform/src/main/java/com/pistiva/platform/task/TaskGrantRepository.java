package com.pistiva.platform.task;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface TaskGrantRepository extends JpaRepository<TaskGrant, UUID> {
    List<TaskGrant> findByTaskId(UUID taskId);

    Optional<TaskGrant> findFirstByTaskIdOrderByCreatedAtDesc(UUID taskId);
}
