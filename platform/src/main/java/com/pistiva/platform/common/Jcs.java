package com.pistiva.platform.common;

import com.fasterxml.jackson.databind.JsonNode;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * RFC 8785 JSON Canonicalization Scheme for the subset of JSON used in signed documents.
 * Non-integer numbers are rejected: amounts are carried as decimal strings so that Java and
 * TypeScript always produce identical bytes.
 */
public final class Jcs {

    private static final long MAX_SAFE_INTEGER = 9007199254740991L;

    private Jcs() {
    }

    public static byte[] canonicalize(JsonNode node) {
        StringBuilder sb = new StringBuilder();
        write(node, sb);
        return sb.toString().getBytes(StandardCharsets.UTF_8);
    }

    private static void write(JsonNode node, StringBuilder sb) {
        switch (node.getNodeType()) {
            case OBJECT -> {
                List<String> names = new ArrayList<>();
                node.fieldNames().forEachRemaining(names::add);
                // String.compareTo orders by UTF-16 code units, as RFC 8785 requires.
                Collections.sort(names);
                sb.append('{');
                for (int i = 0; i < names.size(); i++) {
                    if (i > 0) {
                        sb.append(',');
                    }
                    writeString(names.get(i), sb);
                    sb.append(':');
                    write(node.get(names.get(i)), sb);
                }
                sb.append('}');
            }
            case ARRAY -> {
                sb.append('[');
                for (int i = 0; i < node.size(); i++) {
                    if (i > 0) {
                        sb.append(',');
                    }
                    write(node.get(i), sb);
                }
                sb.append(']');
            }
            case STRING -> writeString(node.textValue(), sb);
            case BOOLEAN -> sb.append(node.booleanValue());
            case NULL -> sb.append("null");
            case NUMBER -> {
                if (!node.canConvertToExactIntegral() || !node.canConvertToLong()
                        || Math.abs(node.longValue()) > MAX_SAFE_INTEGER) {
                    throw new IllegalArgumentException("Signed documents may only contain safe integers; use strings for decimals");
                }
                sb.append(node.longValue());
            }
            default -> throw new IllegalArgumentException("Unsupported JSON node: " + node.getNodeType());
        }
    }

    private static void writeString(String s, StringBuilder sb) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\b' -> sb.append("\\b");
                case '\f' -> sb.append("\\f");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> {
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
                }
            }
        }
        sb.append('"');
    }
}
