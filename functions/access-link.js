import { consumeAccessGrant } from './_access-links.js';

export async function onRequestGet({ request, env }) {
  return consumeAccessGrant(request, env);
}
