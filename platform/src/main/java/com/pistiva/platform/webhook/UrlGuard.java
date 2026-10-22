package com.pistiva.platform.webhook;

import java.net.InetAddress;
import java.net.URI;
import java.net.UnknownHostException;

/**
 * Keeps webhook delivery from reaching the platform's own network. A webhook URL is chosen by a
 * customer, so without this it could point at cloud metadata endpoints, the database or other
 * internal services. Hosts are resolved and every address must be public. The check runs when a
 * webhook is created and again before each delivery, so a name that later resolves to a private
 * address is refused too.
 */
final class UrlGuard {

    private UrlGuard() {
    }

    /** Returns null when the URL's host is acceptable, otherwise a reason. */
    static String problem(URI uri) {
        String host = uri.getHost();
        if (host == null) {
            return "Webhook URL has no host";
        }
        InetAddress[] addresses;
        try {
            addresses = InetAddress.getAllByName(host);
        } catch (UnknownHostException e) {
            return "Webhook host does not resolve";
        }
        for (InetAddress a : addresses) {
            if (isInternal(a)) {
                return "Webhook host resolves to a private or internal address";
            }
        }
        return null;
    }

    static boolean isInternal(InetAddress a) {
        if (a.isAnyLocalAddress() || a.isLoopbackAddress() || a.isLinkLocalAddress() || a.isSiteLocalAddress() || a.isMulticastAddress()) {
            return true;
        }
        byte[] b = a.getAddress();
        if (b.length == 4) {
            int first = b[0] & 0xff;
            int second = b[1] & 0xff;
            // 100.64.0.0/10 carrier-grade NAT, 0.0.0.0/8, 192.0.0.0/24, 198.18.0.0/15 benchmarking, 240.0.0.0/4 reserved
            return first == 0 || (first == 100 && second >= 64 && second <= 127) || (first == 192 && second == 0 && (b[2] & 0xff) == 0)
                    || (first == 198 && (second == 18 || second == 19)) || first >= 240;
        }
        // fc00::/7 unique local
        return (b[0] & 0xfe) == 0xfc;
    }
}
