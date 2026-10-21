package com.pistiva.platform.tasktype;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.io.Resource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.InputStream;
import java.util.List;

/** Registers the domain packs bundled under classpath:domain-packs/ at startup. Idempotent. */
@Component
public class DomainPackLoader implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(DomainPackLoader.class);

    private final TaskTypeService taskTypes;
    private final ObjectMapper mapper;

    public DomainPackLoader(TaskTypeService taskTypes, ObjectMapper mapper) {
        this.taskTypes = taskTypes;
        this.mapper = mapper;
    }

    @Override
    public void run(ApplicationArguments args) throws IOException {
        for (Resource pack : new PathMatchingResourcePatternResolver().getResources("classpath:domain-packs/*.json")) {
            try (InputStream in = pack.getInputStream()) {
                List<String> added = taskTypes.registerPack(mapper.readTree(in));
                if (!added.isEmpty()) {
                    log.info("Registered task types from {}: {}", pack.getFilename(), added);
                }
            }
        }
    }
}
