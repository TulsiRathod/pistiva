package com.pistiva.platform.observability;

import com.pistiva.platform.tasktype.TaskTypeRepository;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import io.micrometer.tracing.Span;
import io.micrometer.tracing.Tracer;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.UUID;

/**
 * The network measures from the product spec (§15), as Prometheus metrics: task completion rate,
 * task latency, the share of unauthorized requests blocked, and certification and webhook health.
 * Tags hold only bounded values (registered task types, states, outcomes); never ids or payload data.
 * Task ids go on trace spans instead, so a trace can be found from an audit entry.
 */
@Component
public class PlatformMetrics {

    public static final String TASK_ID_TAG = "pistiva.task_id";

    private final MeterRegistry registry;
    private final TaskTypeRepository taskTypes;
    private final ObjectProvider<Tracer> tracer;

    public PlatformMetrics(MeterRegistry registry, TaskTypeRepository taskTypes, ObjectProvider<Tracer> tracer) {
        this.registry = registry;
        this.taskTypes = taskTypes;
        this.tracer = tracer;
    }

    public void grant(String capability, boolean issued) {
        Counter.builder("pistiva.grants").description("Grant requests by outcome; denied ones were blocked by platform policy")
                .tag("capability", known(capability)).tag("outcome", issued ? "issued" : "denied")
                .register(registry).increment();
    }

    /** One countersigned round; a terminal round also records the task's outcome and duration since its first grant. */
    public void round(String capability, String state, boolean terminal, Duration sinceFirstGrant) {
        String cap = known(capability);
        Counter.builder("pistiva.task.rounds").description("Countersigned task rounds recorded on the platform")
                .tag("capability", cap).tag("state", state).register(registry).increment();
        if (terminal) {
            Counter.builder("pistiva.tasks.finished").description("Tasks that reached a terminal state")
                    .tag("capability", cap).tag("state", state).register(registry).increment();
            Timer.builder("pistiva.task.duration").description("Time from a task's first grant to its terminal receipt")
                    .tag("capability", cap).tag("state", state)
                    .publishPercentileHistogram()
                    .minimumExpectedValue(Duration.ofMillis(10)).maximumExpectedValue(Duration.ofHours(25))
                    .register(registry).record(sinceFirstGrant);
        }
    }

    public void tasksExpired(int count) {
        if (count > 0) {
            Counter.builder("pistiva.tasks.expired").description("Abandoned tasks expired by the sweeper").register(registry).increment(count);
        }
    }

    /** A request with a bearer token that did not verify: forged, expired, replayed or revoked. */
    public void authRejected(String kind) {
        Counter.builder("pistiva.auth.rejected").description("Requests refused because their credentials did not verify")
                .tag("kind", kind).register(registry).increment();
    }

    public void webhookDelivery(boolean delivered) {
        Counter.builder("pistiva.webhook.deliveries").tag("result", delivered ? "delivered" : "failed").register(registry).increment();
    }

    public void certification(String status) {
        Counter.builder("pistiva.certifications").description("Conformance results submitted by certifiers")
                .tag("status", status).register(registry).increment();
    }

    /** Puts the task id on the current trace span, if tracing is on. */
    public void tagTask(UUID taskId) {
        Tracer t = tracer.getIfAvailable();
        Span span = t == null ? null : t.currentSpan();
        if (span != null && taskId != null) {
            span.tag(TASK_ID_TAG, taskId.toString());
        }
    }

    /** Capability names come from callers; only registered task types become tag values. */
    private String known(String capability) {
        return capability != null && taskTypes.existsById(capability) ? capability : "other";
    }
}
