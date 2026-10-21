package com.pistiva.platform.tasktype;

import com.fasterxml.jackson.databind.JsonNode;
import com.pistiva.platform.common.ApiException;
import com.pistiva.platform.security.Principals;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/** Contracts are public documents: anyone may read them; only platform admins publish packs. */
@RestController
public class TaskTypeController {

    private final TaskTypeService taskTypes;

    public TaskTypeController(TaskTypeService taskTypes) {
        this.taskTypes = taskTypes;
    }

    @GetMapping("/task-types")
    public List<TaskTypeService.TaskTypeSummary> list() {
        return taskTypes.list();
    }

    @GetMapping("/task-types/{name}/versions/{version}")
    public TaskTypeService.TaskTypeView get(@PathVariable String name, @PathVariable int version) {
        return taskTypes.get(name, version);
    }

    @PostMapping("/task-types/packs")
    public Map<String, List<String>> registerPack(@RequestBody JsonNode pack) {
        if (!Principals.user().platformAdmin()) {
            throw new ApiException.Forbidden("Publishing task types requires a platform admin");
        }
        return Map.of("registered", taskTypes.registerPack(pack));
    }
}
