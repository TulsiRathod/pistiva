package com.pistiva.platform.agent;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.UUID;

public interface AgentCardRepository extends JpaRepository<AgentCard, UUID> {
}

