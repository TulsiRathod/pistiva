package com.pistiva.platform.task;

import com.pistiva.platform.audit.AuditService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * Closes tasks that were abandoned: every grant of the task expired long ago and no receipt ever
 * reached a terminal state. The window is longer than the 24-hour clarification deadline nodes use,
 * so a task that is still legitimately waiting for an operator's answer is never swept.
 */
@Component
public class TaskSweeper {

    private static final Logger log = LoggerFactory.getLogger(TaskSweeper.class);

    private final JdbcTemplate jdbc;
    private final AuditService audit;
    private final Duration abandonAfter;

    public TaskSweeper(JdbcTemplate jdbc, AuditService audit, @Value("${pistiva.tasks.abandon-after:25h}") Duration abandonAfter) {
        this.jdbc = jdbc;
        this.audit = audit;
        this.abandonAfter = abandonAfter;
    }

    @Scheduled(fixedDelayString = "${pistiva.tasks.sweep-interval:10m}", initialDelayString = "${pistiva.tasks.sweep-interval:10m}")
    public void scheduled() {
        try {
            int n = sweep();
            if (n > 0) {
                log.info("Expired {} abandoned task(s)", n);
            }
        } catch (RuntimeException e) {
            log.warn("Task sweep failed: {}", e.getMessage());
        }
    }

    /** Returns the number of tasks expired. Safe to run concurrently on several instances. */
    public int sweep() {
        List<Map<String, Object>> expired = jdbc.queryForList("""
                WITH abandoned AS (
                  SELECT g.task_id FROM task_grants g
                  GROUP BY g.task_id
                  HAVING bool_and(g.status = 'ISSUED') AND max(g.expires_at) < now() - (? || ' seconds')::interval
                     AND NOT EXISTS (SELECT 1 FROM task_receipts r WHERE r.task_id = g.task_id
                                     AND r.state IN ('completed', 'failed', 'rejected', 'canceled'))
                )
                UPDATE task_grants g SET status = 'EXPIRED'
                FROM abandoned a WHERE g.task_id = a.task_id AND g.status = 'ISSUED'
                RETURNING g.task_id, g.capability,
                  (SELECT org_id FROM agents WHERE id = g.requester_agent_id) AS requester_org,
                  (SELECT org_id FROM agents WHERE id = g.provider_agent_id) AS provider_org""",
                String.valueOf(abandonAfter.toSeconds()));
        expired.stream()
                .collect(Collectors.toMap(r -> (UUID) r.get("task_id"), r -> r, (a, b) -> a))
                .values()
                .forEach(r -> audit.record((UUID) r.get("task_id"), "TASK_EXPIRED", "platform:sweeper",
                        (UUID) r.get("requester_org"), (UUID) r.get("provider_org"), null, null,
                        Map.of("capability", r.get("capability"), "reason", "No terminal receipt within " + abandonAfter.toHours() + "h")));
        return (int) expired.stream().map(r -> r.get("task_id")).distinct().count();
    }
}
