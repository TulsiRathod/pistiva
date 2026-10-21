package com.pistiva.platform.org;

import org.springframework.stereotype.Component;

import javax.naming.NamingEnumeration;
import javax.naming.NamingException;
import javax.naming.directory.Attribute;
import javax.naming.directory.InitialDirContext;
import java.util.Hashtable;

/**
 * Proves domain control: the org publishes {@code pistiva-verification=<token>} as a TXT record at
 * {@code _pistiva-verification.<domain>}.
 */
@Component
public class DnsVerifier {

    public boolean hasToken(String domain, String token) {
        Hashtable<String, String> env = new Hashtable<>();
        env.put("java.naming.factory.initial", "com.sun.jndi.dns.DnsContextFactory");
        try {
            var ctx = new InitialDirContext(env);
            Attribute txt = ctx.getAttributes("_pistiva-verification." + domain, new String[]{"TXT"}).get("TXT");
            if (txt == null) {
                return false;
            }
            NamingEnumeration<?> values = txt.getAll();
            while (values.hasMore()) {
                String value = values.next().toString().replace("\"", "").trim();
                if (value.equals("pistiva-verification=" + token)) {
                    return true;
                }
            }
            return false;
        } catch (NamingException e) {
            return false;
        }
    }
}
