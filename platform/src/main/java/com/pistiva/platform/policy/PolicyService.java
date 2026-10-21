package com.pistiva.platform.policy;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.UUID;

@Service
public class PolicyService {

    private final PolicyRepository policies;
    private final ObjectMapper mapper;

    public PolicyService(PolicyRepository policies, ObjectMapper mapper) {
        this.policies = policies;
        this.mapper = mapper;
    }

    @Transactional
    public void createDefault(UUID orgId) {
        policies.save(new Policy(orgId, toJson(PolicyRules.defaults())));
    }

    public PolicyRules get(UUID orgId) {
        return policies.findById(orgId)
                .map(p -> fromJson(p.getRulesJson()))
                .orElseGet(PolicyRules::defaults);
    }

    @Transactional
    public PolicyRules update(UUID orgId, PolicyRules rules) {
        String json = toJson(rules);
        policies.findById(orgId).ifPresentOrElse(p -> p.update(json), () -> policies.save(new Policy(orgId, json)));
        return rules;
    }

    private String toJson(PolicyRules rules) {
        try {
            return mapper.writeValueAsString(rules);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }

    private PolicyRules fromJson(String json) {
        try {
            return mapper.readValue(json, PolicyRules.class);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Stored policy is unreadable", e);
        }
    }
}
