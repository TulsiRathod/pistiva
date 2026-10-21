package com.pistiva.platform.tasktype;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface TaskTypeVersionRepository extends JpaRepository<TaskTypeVersion, TaskTypeVersion.Key> {
    List<TaskTypeVersion> findByNameOrderByVersionAsc(String name);
}
