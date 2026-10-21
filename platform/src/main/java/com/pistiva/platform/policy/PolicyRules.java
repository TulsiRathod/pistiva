package com.pistiva.platform.policy;

import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;

import java.math.BigDecimal;
import java.util.List;

/**
 * An organization's rules for the tasks its agents may request.
 *
 * @param allowedCapabilities capabilities its agents may request from providers
 * @param maxBudgetPerTask    hard cap; grants above it are denied
 * @param approvalThreshold   grants above it are issued with approvalRequired=true, so no
 *                            commitment can be made without a human approval
 * @param rateLimitPerMinute  grant requests per agent per minute
 */
public record PolicyRules(
        @NotNull List<@Pattern(regexp = PolicyRules.CAPABILITY_PATTERN) String> allowedCapabilities,
        @NotNull @DecimalMin("0") BigDecimal maxBudgetPerTask,
        @NotNull @DecimalMin("0") BigDecimal approvalThreshold,
        @NotNull @Pattern(regexp = "[A-Z]{3}") String currency,
        @Min(1) @Max(10_000) int rateLimitPerMinute) {

    public static final String CAPABILITY_PATTERN = "^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$";

    /** New organizations may ask for quotes and hold drafts; committing orders (order.confirm) must be enabled explicitly. */
    public static PolicyRules defaults() {
        return new PolicyRules(List.of("quote.request", "order.draft"), new BigDecimal("50000.00"), new BigDecimal("10000.00"), "INR", 30);
    }
}
