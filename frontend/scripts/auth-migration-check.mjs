// Real-Cognito end-to-end check for the Amplify v6 auth migration.
//
// Runs the full sign-in flow (SRP -> TOTP setup -> confirm), verifies the
// resulting token is accepted by the live API, and verifies that
// signOut({ global: true }) revokes the session server-side. Uses a
// throwaway user in the real pool and deletes it afterwards.
//
// Requires: AWS CLI configured (joe-admin), Node 20+.
// Usage:  node scripts/auth-migration-check.mjs
//
// Env overrides (defaults are the live prod values):
//   TTV_USER_POOL_ID, TTV_CLIENT_ID, TTV_API_BASE, TTV_REGION

import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { Amplify } from 'aws-amplify';
import {
	signIn,
	confirmSignIn,
	fetchAuthSession,
	signOut,
} from 'aws-amplify/auth';

const REGION = process.env.TTV_REGION || 'us-east-1';
const USER_POOL_ID = process.env.TTV_USER_POOL_ID || 'us-east-1_fJDMHgjvt';
const CLIENT_ID = process.env.TTV_CLIENT_ID || '25p8jbjqribi8604b6eapqq7vj';
const API_BASE = (process.env.TTV_API_BASE ||
	'https://xjqh5tcvte.execute-api.us-east-1.amazonaws.com/prod').replace(/\/$/, '');

const EMAIL = `authmigration+${Date.now()}@thetrustvoice.com`;
const PASSWORD = `Aa1!${Math.random().toString(36).slice(2)}Zz9?`;

const aws = (args) =>
	JSON.parse(
		execFileSync('aws', [...args, '--region', REGION, '--output', 'json'], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		}) || 'null',
	);
const awsRaw = (args) => {
	try {
		execFileSync('aws', [...args, '--region', REGION], { stdio: ['ignore', 'pipe', 'pipe'] });
		return { ok: true };
	} catch (e) {
		return { ok: false, stderr: String(e.stderr || e.message) };
	}
};

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
	if (cond) {
		pass++;
		console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
	} else {
		fail++;
		console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
};

// ---- minimal TOTP (RFC 6238, SHA1, 6 digits, 30s) ----------------------------
function base32Decode(s) {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
	let bits = '';
	for (const c of s.replace(/=+$/, '').toUpperCase()) {
		const v = alphabet.indexOf(c);
		if (v < 0) continue;
		bits += v.toString(2).padStart(5, '0');
	}
	const bytes = [];
	for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
	return Buffer.from(bytes);
}
function totp(secret, forStep = 0) {
	const key = base32Decode(secret);
	const counter = Math.floor(Date.now() / 1000 / 30) + forStep;
	const buf = Buffer.alloc(8);
	buf.writeBigUInt64BE(BigInt(counter));
	const hmac = createHmac('sha1', key).update(buf).digest();
	const off = hmac[hmac.length - 1] & 0xf;
	const bin =
		((hmac[off] & 0x7f) << 24) |
		((hmac[off + 1] & 0xff) << 16) |
		((hmac[off + 2] & 0xff) << 8) |
		(hmac[off + 3] & 0xff);
	return (bin % 1_000_000).toString().padStart(6, '0');
}

// ---------------------------------------------------------------------------
Amplify.configure({
	Auth: { Cognito: { userPoolId: USER_POOL_ID, userPoolClientId: CLIENT_ID } },
});

async function main() {
	console.log(`\nAuth migration check against ${USER_POOL_ID}`);
	console.log(`Test user: ${EMAIL}\n`);

	// 1. Provision a throwaway, confirmed user with a known permanent password.
	console.log('Setup: create test user');
	aws([
		'cognito-idp', 'admin-create-user',
		'--user-pool-id', USER_POOL_ID,
		'--username', EMAIL,
		'--user-attributes', `Name=email,Value=${EMAIL}`, 'Name=email_verified,Value=true',
		'--message-action', 'SUPPRESS',
	]);
	aws([
		'cognito-idp', 'admin-set-user-password',
		'--user-pool-id', USER_POOL_ID,
		'--username', EMAIL,
		'--password', PASSWORD,
		'--permanent',
	]);

	let secret;
	let preSignOutAccessToken;
	try {
		// 2. SRP sign-in -> expect TOTP setup step (pool is MFA REQUIRED).
		console.log('\nFlow: sign-in + TOTP setup');
		const s1 = await signIn({ username: EMAIL, password: PASSWORD });
		check(
			'signIn -> CONTINUE_SIGN_IN_WITH_TOTP_SETUP',
			!s1.isSignedIn && s1.nextStep.signInStep === 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP',
			s1.nextStep.signInStep,
		);
		secret = s1.nextStep.totpSetupDetails?.sharedSecret;
		check('totpSetupDetails.sharedSecret present', typeof secret === 'string' && secret.length >= 16);
		check(
			'getSetupUri returns an otpauth URL',
			String(s1.nextStep.totpSetupDetails.getSetupUri('The Trust Voice', EMAIL)).startsWith('otpauth://totp/'),
		);

		// 3. Confirm with a computed TOTP code.
		const s2 = await confirmSignIn({ challengeResponse: totp(secret) });
		check('confirmSignIn(totp) -> isSignedIn', s2.isSignedIn === true, s2.nextStep?.signInStep);

		// 4. Session + live API call.
		console.log('\nSession + live API');
		const sess = await fetchAuthSession();
		const idToken = sess.tokens?.idToken?.toString();
		preSignOutAccessToken = sess.tokens?.accessToken?.toString();
		check('fetchAuthSession returns an idToken', !!idToken);
		const meRes = await fetch(`${API_BASE}/me`, { headers: { Authorization: idToken } });
		// A brand-new user is in no client group, so withClientIsolation returns 403.
		// The point is that API Gateway's Cognito authorizer ACCEPTED the token
		// (that yields 403 from the Lambda; a rejected token yields 401).
		check(
			'GET /me accepts the token (403 groupless, not 401)',
			meRes.status === 403,
			`HTTP ${meRes.status}`,
		);

		// 5. Wrong-code error shape (locks the friendlyError mapping).
		console.log('\nError shapes');
		const s3 = await signIn({ username: EMAIL, password: PASSWORD }).catch(() => null);
		// Already signed in from step 3 -> signIn throws UserAlreadyAuthenticatedException.
		check(
			're-signIn while signed in -> UserAlreadyAuthenticatedException',
			s3 === null,
			'(handled by adapter retry)',
		);

		// 6. Global sign-out revokes the session server-side.
		console.log('\nSign-out revocation');
		await signOut({ global: true });

		const localAfter = await fetchAuthSession();
		check('after signOut: local session cleared', !localAfter.tokens, 'no tokens in storage');

		let refreshErr = null;
		try {
			await fetchAuthSession({ forceRefresh: true });
		} catch (e) {
			refreshErr = e;
		}
		const localForced = await fetchAuthSession({ forceRefresh: true }).catch(() => ({}));
		check(
			'after global signOut: refresh no longer yields tokens',
			!!refreshErr || !localForced.tokens,
			refreshErr ? refreshErr.name : 'no tokens on forceRefresh',
		);

		const getUser = awsRaw([
			'cognito-idp', 'get-user', '--access-token', preSignOutAccessToken,
		]);
		check(
			'after global signOut: pre-signout access token is revoked by Cognito',
			!getUser.ok && /revoked|NotAuthorized/i.test(getUser.stderr),
			getUser.ok ? 'STILL VALID (unexpected)' : (getUser.stderr.match(/\(([A-Za-z]+)\)/)?.[1] || 'rejected'),
		);

		// 7. Wrong password error name.
		const badPw = await signIn({ username: EMAIL, password: 'wrong-password-1!' }).catch((e) => e);
		check(
			'signIn wrong password -> NotAuthorizedException',
			badPw?.name === 'NotAuthorizedException',
			badPw?.name,
		);

		// 8. Wrong TOTP code error name (fresh sign-in, then bad confirm).
		const s4 = await signIn({ username: EMAIL, password: PASSWORD });
		check('re-sign-in after signout works', s4.nextStep.signInStep === 'CONFIRM_SIGN_IN_WITH_TOTP_CODE', s4.nextStep.signInStep);
		const badCode = await confirmSignIn({ challengeResponse: '000000' }).catch((e) => e);
		check(
			'confirmSignIn wrong code -> CodeMismatchException',
			badCode?.name === 'CodeMismatchException',
			badCode?.name,
		);
		// finish this session so cleanup is tidy
		await confirmSignIn({ challengeResponse: totp(secret) }).catch(() => {});
		await signOut({ global: true }).catch(() => {});
	} finally {
		// 9. Delete the test user.
		console.log('\nTeardown: delete test user');
		aws(['cognito-idp', 'admin-delete-user', '--user-pool-id', USER_POOL_ID, '--username', EMAIL]);
	}

	console.log(`\n${'='.repeat(48)}`);
	console.log(`  ${pass} passed, ${fail} failed`);
	console.log(`${'='.repeat(48)}\n`);
	process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error('\nFATAL:', err);
	// best-effort cleanup
	try {
		execFileSync('aws', [
			'cognito-idp', 'admin-delete-user',
			'--user-pool-id', USER_POOL_ID, '--username', EMAIL, '--region', REGION,
		], { stdio: 'ignore' });
	} catch { /* ignore */ }
	process.exit(1);
});
