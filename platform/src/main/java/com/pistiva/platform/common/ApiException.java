package com.pistiva.platform.common;

import org.springframework.http.HttpStatus;

public class ApiException extends RuntimeException {

    private final HttpStatus status;
    private final String code;

    protected ApiException(HttpStatus status, String code, String message) {
        super(message);
        this.status = status;
        this.code = code;
    }

    public HttpStatus status() {
        return status;
    }

    public String code() {
        return code;
    }

    public static class BadRequest extends ApiException {
        public BadRequest(String message) {
            super(HttpStatus.BAD_REQUEST, "bad_request", message);
        }
    }

    public static class Unauthorized extends ApiException {
        public Unauthorized(String message) {
            super(HttpStatus.UNAUTHORIZED, "unauthorized", message);
        }
    }

    public static class Forbidden extends ApiException {
        public Forbidden(String message) {
            super(HttpStatus.FORBIDDEN, "forbidden", message);
        }
    }

    public static class NotFound extends ApiException {
        public NotFound(String message) {
            super(HttpStatus.NOT_FOUND, "not_found", message);
        }
    }

    public static class Conflict extends ApiException {
        public Conflict(String message) {
            super(HttpStatus.CONFLICT, "conflict", message);
        }
    }

    /** A policy decision denied the request. The reason is returned to the caller and audited. */
    public static class PolicyDenied extends ApiException {
        public PolicyDenied(String reason) {
            super(HttpStatus.FORBIDDEN, "policy_denied", reason);
        }
    }

    /** A commitment needs a human approval first; the caller should request one and retry with it. */
    public static class ApprovalRequired extends ApiException {
        public ApprovalRequired(String reason) {
            super(HttpStatus.FORBIDDEN, "approval_required", reason);
        }
    }
}
