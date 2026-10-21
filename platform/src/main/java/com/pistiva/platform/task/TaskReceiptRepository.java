package com.pistiva.platform.task;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

public interface TaskReceiptRepository extends JpaRepository<TaskReceipt, TaskReceipt.Key> {
    List<TaskReceipt> findByTaskIdOrderByRoundAsc(UUID taskId);
}
