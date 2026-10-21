package com.pistiva.platform.agent;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

public interface AgentCapabilityRepository extends JpaRepository<AgentCapability, UUID> {
    List<AgentCapability> findByCapability(String capability);

    List<AgentCapability> findByAgentId(UUID agentId);

    void deleteByAgentId(UUID agentId);
}

