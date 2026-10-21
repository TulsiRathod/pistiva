package com.pistiva.platform.security;

import com.pistiva.platform.PlatformProperties;
import com.pistiva.platform.identity.TokenService;
import org.springframework.beans.factory.annotation.Value;
import com.pistiva.platform.observability.PlatformMetrics;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.crypto.factory.PasswordEncoderFactories;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.HttpStatusEntryPoint;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;

import java.util.Arrays;
import java.util.List;

@Configuration
public class SecurityConfig {

    @Bean
    SecurityFilterChain filterChain(HttpSecurity http, TokenService tokens, PlatformMetrics metrics,
                                    @Value("${pistiva.metrics.token:}") String metricsToken) throws Exception {
        http
                .csrf(csrf -> csrf.disable())
                .cors(cors -> {
                })
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .httpBasic(b -> b.disable())
                .formLogin(f -> f.disable())
                .exceptionHandling(e -> e.authenticationEntryPoint(new HttpStatusEntryPoint(HttpStatus.UNAUTHORIZED)))
                .authorizeHttpRequests(auth -> auth
                        .requestMatchers("/auth/register", "/auth/login", "/.well-known/**",
                                "/actuator/health", "/v3/api-docs/**", "/swagger-ui/**", "/swagger-ui.html", "/error")
                        .permitAll()
                        .requestMatchers(HttpMethod.GET, "/task-types", "/task-types/**").permitAll()
                        .requestMatchers(MetricsTokenFilter.PATH).hasRole(MetricsTokenFilter.ROLE)
                        .anyRequest().authenticated())
                .addFilterBefore(new MetricsTokenFilter(metricsToken), UsernamePasswordAuthenticationFilter.class)
                .addFilterAfter(new BearerAuthFilter(tokens, metrics), MetricsTokenFilter.class);
        return http.build();
    }

    @Bean
    CorsConfigurationSource corsConfigurationSource(PlatformProperties props) {
        CorsConfiguration config = new CorsConfiguration();
        config.setAllowedOrigins(Arrays.stream(props.corsOrigins().split(",")).map(String::trim).toList());
        config.setAllowedMethods(List.of("GET", "POST", "PUT", "DELETE"));
        config.setAllowedHeaders(List.of("Authorization", "Content-Type"));
        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/**", config);
        return source;
    }

    @Bean
    PasswordEncoder passwordEncoder() {
        return PasswordEncoderFactories.createDelegatingPasswordEncoder();
    }
}
