package com.pistiva.platform.tasktype;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.pistiva.platform.common.ApiException;
import com.pistiva.platform.policy.PolicyRules;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/**
 * Registry of task-type contracts. A domain pack is a set of task types sharing a vocabulary
 * ({@code $defs}); each message schema is stored self-contained, with the pack's definitions inlined,
 * so gateways can validate with any JSON Schema 2020-12 validator without resolving references.
 */
@Service
public class TaskTypeService {

    static final String SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";
    private static final Set<String> MESSAGE_KINDS = Set.of("request", "clarification", "answer", "result");

    private final TaskTypeRepository types;
    private final TaskTypeVersionRepository versions;
    private final ObjectMapper mapper;

    public TaskTypeService(TaskTypeRepository types, TaskTypeVersionRepository versions, ObjectMapper mapper) {
        this.types = types;
        this.versions = versions;
        this.mapper = mapper;
    }

    public record TaskTypeView(String name, int version, String pack, String description, boolean extension,
                               String direction, String cardinality, String handler, JsonNode messages) {
    }

    public record TaskTypeSummary(String name, String pack, String description, boolean extension, List<Integer> versions) {
    }

    /** Registers every task type in a pack. Re-registering an identical version is a no-op; changing one is refused. */
    @Transactional
    public List<String> registerPack(JsonNode pack) {
        String packName = text(pack, "pack");
        JsonNode defs = pack.path("$defs");
        List<String> registered = new ArrayList<>();
        for (JsonNode t : pack.path("taskTypes")) {
            String name = text(t, "name");
            if (!name.matches(PolicyRules.CAPABILITY_PATTERN)) {
                throw new ApiException.BadRequest("Invalid task type name: " + name);
            }
            int version = t.path("version").asInt(0);
            if (version < 1) {
                throw new ApiException.BadRequest(name + ": version must be a positive integer");
            }
            TaskTypeVersion.Direction direction = parse(TaskTypeVersion.Direction.class, text(t, "direction"), name);
            TaskTypeVersion.Cardinality cardinality = parse(TaskTypeVersion.Cardinality.class, text(t, "cardinality"), name);
            String messages = toJson(selfContainedMessages(name, t.path("messages"), defs));

            TaskType existing = types.findById(name).orElse(null);
            if (existing == null) {
                types.save(new TaskType(name, packName, text(t, "description"), t.path("extension").asBoolean(false)));
            } else if (!existing.getPack().equals(packName)) {
                throw new ApiException.Conflict(name + " already belongs to pack " + existing.getPack());
            }
            var key = new TaskTypeVersion.Key(name, version);
            var current = versions.findById(key).orElse(null);
            if (current == null) {
                versions.save(new TaskTypeVersion(name, version, direction, cardinality, text(t, "handler"), messages));
                registered.add(name + "@" + version);
            } else if (!readTree(current.getMessages()).equals(readTree(messages))
                    || current.getDirection() != direction || current.getCardinality() != cardinality) {
                throw new ApiException.Conflict(name + "@" + version + " is published and immutable; register a new version");
            }
        }
        return registered;
    }

    public TaskTypeView get(String name, int version) {
        TaskType type = types.findById(name).orElseThrow(() -> new ApiException.NotFound("Unknown task type " + name));
        TaskTypeVersion v = versions.findById(new TaskTypeVersion.Key(name, version))
                .orElseThrow(() -> new ApiException.NotFound("Unknown version " + name + "@" + version));
        return new TaskTypeView(name, version, type.getPack(), type.getDescription(), type.isExtension(),
                v.getDirection().name(), v.getCardinality().name(), v.getHandler(), readTree(v.getMessages()));
    }

    public boolean exists(String name, int version) {
        return versions.existsById(new TaskTypeVersion.Key(name, version));
    }

    public List<TaskTypeSummary> list() {
        return types.findAll().stream()
                .map(t -> new TaskTypeSummary(t.getName(), t.getPack(), t.getDescription(), t.isExtension(),
                        versions.findByNameOrderByVersionAsc(t.getName()).stream().map(TaskTypeVersion::getVersion).toList()))
                .toList();
    }

    private ObjectNode selfContainedMessages(String name, JsonNode messages, JsonNode defs) {
        if (!messages.isObject() || !messages.has("request") || !messages.has("result")) {
            throw new ApiException.BadRequest(name + ": messages.request and messages.result are required");
        }
        if (messages.has("clarification") != messages.has("answer")) {
            throw new ApiException.BadRequest(name + ": clarification and answer schemas come as a pair");
        }
        ObjectNode out = mapper.createObjectNode();
        messages.fields().forEachRemaining(e -> {
            if (!MESSAGE_KINDS.contains(e.getKey())) {
                throw new ApiException.BadRequest(name + ": unknown message kind " + e.getKey());
            }
            if (!e.getValue().isObject() || !"object".equals(e.getValue().path("type").asText())) {
                throw new ApiException.BadRequest(name + ": " + e.getKey() + " schema must describe an object");
            }
            ObjectNode schema = mapper.createObjectNode().put("$schema", SCHEMA_DIALECT);
            schema.setAll((ObjectNode) e.getValue().deepCopy());
            if (defs.isObject() && !defs.isEmpty()) {
                schema.set("$defs", defs.deepCopy());
            }
            out.set(e.getKey(), schema);
        });
        return out;
    }

    private static <E extends Enum<E>> E parse(Class<E> type, String value, String name) {
        try {
            return Enum.valueOf(type, value);
        } catch (IllegalArgumentException e) {
            throw new ApiException.BadRequest(name + ": invalid " + type.getSimpleName().toLowerCase() + " " + value);
        }
    }

    private static String text(JsonNode node, String field) {
        String value = node.path(field).asText("");
        if (value.isBlank()) {
            throw new ApiException.BadRequest("Missing " + field);
        }
        return value;
    }

    private JsonNode readTree(String json) {
        try {
            return mapper.readTree(json);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }

    private String toJson(JsonNode node) {
        try {
            return mapper.writeValueAsString(node);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }
}
