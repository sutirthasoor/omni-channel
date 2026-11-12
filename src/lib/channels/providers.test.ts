import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertSafeGatewayUrl,
  renderBodyTemplate,
  sendViaProvider,
} from './providers';
import { ChannelError } from './types';

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('renderBodyTemplate', () => {
  it('JSON-escapes substituted values', () => {
    const out = renderBodyTemplate('{"t":"{{text}}"}', { text: 'say "hi"\nbye' });
    expect(JSON.parse(out)).toEqual({ t: 'say "hi"\nbye' });
  });
});

describe('assertSafeGatewayUrl', () => {
  it('accepts public https and rejects http / internal hosts', () => {
    expect(() => assertSafeGatewayUrl('https://api.example.com/x')).not.toThrow();
    for (const bad of ['http://api.example.com', 'https://localhost/x', 'https://10.0.0.5/x', 'https://169.254.169.254/']) {
      expect(() => assertSafeGatewayUrl(bad)).toThrow(ChannelError);
    }
  });
});

describe('twilio', () => {
  const creds = { account_sid: 'ACx', auth_token: 'tok', sender: '+15550001111' };

  it('sends SMS as form-encoded with basic auth and returns the SID', async () => {
    const fetchMock = mockFetch(201, { sid: 'SM123' });
    const res = await sendViaProvider('sms', 'twilio', creds, { to: '+91 98765 43210', text: 'hello' }, { statusCallbackUrl: 'https://crm/cb' });
    expect(res.providerMessageId).toBe('SM123');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/Accounts/ACx/Messages.json');
    const form = new URLSearchParams(init.body as string);
    expect(form.get('To')).toBe('+919876543210');
    expect(form.get('From')).toBe('+15550001111');
    expect(form.get('StatusCallback')).toBe('https://crm/cb');
  });

  it('RCS with a Messaging Service uses MessagingServiceSid (SMS fallback)', async () => {
    const fetchMock = mockFetch(201, { sid: 'MM1' });
    await sendViaProvider('rcs', 'twilio', { ...creds, sender: 'MGabc' }, { to: '+919876543210', text: 'x' });
    const form = new URLSearchParams((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(form.get('MessagingServiceSid')).toBe('MGabc');
    expect(form.get('From')).toBeNull();
  });

  it('RCS with a direct agent id prefixes From and To with rcs:', async () => {
    const fetchMock = mockFetch(201, { sid: 'MM2' });
    await sendViaProvider('rcs', 'twilio', { ...creds, sender: 'brand_x_agent' }, { to: '+919876543210', text: 'x' });
    const form = new URLSearchParams((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(form.get('From')).toBe('rcs:brand_x_agent');
    expect(form.get('To')).toBe('rcs:+919876543210');
  });

  it('surfaces the provider error message', async () => {
    mockFetch(400, { message: 'Invalid To number' });
    await expect(sendViaProvider('sms', 'twilio', creds, { to: '+1555', text: 'x' })).rejects.toThrow(/Invalid To number/);
  });
});

describe('msg91', () => {
  it('prepends the default country code to 10-digit numbers', async () => {
    const fetchMock = mockFetch(200, { type: 'success', message: 'req-1' });
    const res = await sendViaProvider('sms', 'msg91', { authkey: 'k', template_id: 't' }, { to: '9876543210', text: 'hi' });
    expect(res.providerMessageId).toBe('req-1');
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.recipients[0]).toEqual({ mobiles: '919876543210', VAR1: 'hi' });
  });
});

describe('emailjs', () => {
  it('posts service/template/keys and template params', async () => {
    const fetchMock = mockFetch(200, 'OK');
    await sendViaProvider('email', 'emailjs', { service_id: 's', template_id: 't', public_key: 'pub', private_key: 'priv' }, { to: 'a@b.com', text: 'body', subject: 'Hi', recipientName: 'Asha' });
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toMatchObject({ service_id: 's', template_id: 't', user_id: 'pub', accessToken: 'priv' });
    expect(body.template_params).toMatchObject({ to_email: 'a@b.com', to_name: 'Asha', subject: 'Hi', message: 'body' });
  });

  it('reports EmailJS failures', async () => {
    mockFetch(422, 'The recipients address is corrupted');
    await expect(sendViaProvider('email', 'emailjs', { service_id: 's', template_id: 't', public_key: 'p', private_key: 'k' }, { to: 'bad', text: 'x' })).rejects.toThrow(/corrupted/);
  });
});

describe('http gateway', () => {
  it('renders the template, sends the auth header and reads the id path', async () => {
    const fetchMock = mockFetch(200, { data: { message_id: 'g-9' } });
    const res = await sendViaProvider(
      'rcs',
      'http',
      { url: 'https://gw.example.com/send', auth_header_name: 'Authorization', auth_header_value: 'Bearer z', sender: 'agent1', body_template: '{"from":"{{from}}","to":"{{to}}","text":"{{text}}"}', message_id_path: 'data.message_id' },
      { to: '+919876543210', text: 'hey' }
    );
    expect(res.providerMessageId).toBe('g-9');
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer z');
    expect(JSON.parse(init.body as string)).toEqual({ from: 'agent1', to: '+919876543210', text: 'hey' });
  });
});
