/**
 * Registers DepGate as a SAML client in the test Keycloak, through the Keycloak admin API, the way an
 * admin would after copying the SP entity ID and ACS URL from DepGate. The realm export has no SAML
 * client because its client ID is the SP entity ID, which carries DepGate's provider id.
 */
const KEYCLOAK = process.env.E2E_KEYCLOAK_URL ?? 'http://localhost:8180';
const REALM = 'depgate';

async function adminToken(): Promise<string> {
  const res = await fetch(`${KEYCLOAK}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: 'admin', password: 'admin' }),
  });
  if (!res.ok) throw new Error(`Keycloak admin sign-in failed: HTTP ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function findClient(token: string, clientId: string): Promise<{ id: string } | null> {
  const res = await fetch(`${KEYCLOAK}/admin/realms/${REALM}/clients?clientId=${encodeURIComponent(clientId)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const list = (await res.json()) as Array<{ id: string }>;
  return list[0] ?? null;
}

/** Signed responses and assertions, email NameID, an email attribute. Unsigned requests are accepted. */
export async function registerSamlClient(spEntityId: string, acsUrl: string): Promise<void> {
  const token = await adminToken();
  const existing = await findClient(token, spEntityId);
  const client = {
    clientId: spEntityId,
    name: 'DepGate (SAML, e2e)',
    protocol: 'saml',
    enabled: true,
    frontchannelLogout: false,
    redirectUris: [acsUrl],
    attributes: {
      'saml.assertion.signature': 'true',
      'saml.server.signature': 'true',
      'saml.client.signature': 'false',
      'saml.encrypt': 'false',
      'saml.force.post.binding': 'true',
      'saml.authnstatement': 'true',
      'saml.signature.algorithm': 'RSA_SHA256',
      saml_signature_canonicalization_method: 'http://www.w3.org/2001/10/xml-exc-c14n#',
      saml_force_name_id_format: 'true',
      saml_name_id_format: 'email',
      saml_assertion_consumer_url_post: acsUrl,
    },
    protocolMappers: [
      {
        name: 'email',
        protocol: 'saml',
        protocolMapper: 'saml-user-property-mapper',
        config: { 'user.attribute': 'email', 'attribute.name': 'email', 'attribute.nameformat': 'Basic', 'friendly.name': 'email' },
      },
      {
        name: 'firstName',
        protocol: 'saml',
        protocolMapper: 'saml-user-property-mapper',
        config: { 'user.attribute': 'firstName', 'attribute.name': 'firstName', 'attribute.nameformat': 'Basic' },
      },
    ],
  };
  const url = existing ? `${KEYCLOAK}/admin/realms/${REALM}/clients/${existing.id}` : `${KEYCLOAK}/admin/realms/${REALM}/clients`;
  const res = await fetch(url, {
    method: existing ? 'PUT' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(client),
  });
  if (!res.ok) throw new Error(`Could not register the SAML client in Keycloak: HTTP ${res.status} ${await res.text()}`);
}

/** Removes every SAML client this suite registered for DepGate. */
export async function removeSamlClients(): Promise<void> {
  const token = await adminToken();
  const res = await fetch(`${KEYCLOAK}/admin/realms/${REALM}/clients?max=500`, { headers: { authorization: `Bearer ${token}` } });
  const clients = (await res.json()) as Array<{ id: string; clientId: string; protocol?: string; name?: string }>;
  for (const client of clients) {
    if (client.protocol === 'saml' && client.name === 'DepGate (SAML, e2e)') {
      await fetch(`${KEYCLOAK}/admin/realms/${REALM}/clients/${client.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
    }
  }
}
