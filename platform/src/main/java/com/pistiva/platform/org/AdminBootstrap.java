package com.pistiva.platform.org;

import com.pistiva.platform.PlatformProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;

/** Creates the configured platform-admin account on first start. */
@Component
public class AdminBootstrap implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(AdminBootstrap.class);

    private final UserRepository users;
    private final PasswordEncoder passwordEncoder;
    private final PlatformProperties props;

    public AdminBootstrap(UserRepository users, PasswordEncoder passwordEncoder, PlatformProperties props) {
        this.users = users;
        this.passwordEncoder = passwordEncoder;
        this.props = props;
    }

    @Override
    public void run(ApplicationArguments args) {
        String email = props.adminEmail().trim().toLowerCase();
        if (users.findByEmail(email).isEmpty()) {
            users.save(new User(email, passwordEncoder.encode(props.adminPassword()), true));
            log.info("Created platform admin {}", email);
        }
    }
}
