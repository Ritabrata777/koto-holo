// Read-only deployment check after migration 003. Never creates data.
import assert from 'node:assert/strict';
import { SUPABASE_URL, SUPABASE_API_KEY } from '../config.js';
const headers={apikey:SUPABASE_API_KEY,'Content-Type':'application/json'};
for (const table of ['hs_trips','hs_members','hs_expenses','hs_expense_shares','hs_payments','hs_profiles']) {
  const response=await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*&limit=0`,{headers});
  assert.ok([401,403].includes(response.status),`${table}: expected denied access, got ${response.status}`);
  console.log(`${table}: anonymous table access denied`);
}
for (const [name,args] of Object.entries({
  hs_get_profile:{},hs_my_groups:{},
  hs_get_trip:{p_token:'invalid-check-token-1234567890'},
  hs__trip:{p_token:'invalid-check-token-1234567890'},
})) {
  const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{method:'POST',headers,body:JSON.stringify(args)});
  assert.ok([401,403].includes(response.status),`${name}: expected denied access, got ${response.status}; check migration 003`);
  console.log(`${name}: anonymous execution denied`);
}
console.log('Anonymous-access checks passed. Signed-in permission scenarios run in npm test.');
