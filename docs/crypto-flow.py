# -*- coding: utf-8 -*-
"""Builds docs/crypto-flow.pdf — how the cryptography flows, password to expense.

The diagram is generated rather than drawn so it can be re-derived when the
design moves. Regenerate with:

    python3 docs/crypto-flow.py
    chromium --headless --no-pdf-header-footer \
        --print-to-pdf=docs/crypto-flow.pdf docs/crypto-flow.html

Sources it describes: packages/shared/src/crypto.ts and
apps/web/src/{keys,groupKeys,entryKeys,envelope,aad,groupName,reseal}.ts.
"""

from html import escape

# --------------------------------------------------------------------------
# palette / primitives
# --------------------------------------------------------------------------
K = {
    'sec':   ('#0d7268', '#e2f2ef', '#0a5a52'),   # device-only secret
    'pub':   ('#4a5a70', '#edf1f6', '#39465a'),   # public / server-held
    'ct':    ('#4b46a6', '#ecebfa', '#3a3684'),   # ciphertext
    'hum':   ('#a32f4d', '#fbe9ee', '#82253c'),   # human / out-of-band
    'warn':  ('#8a5a10', '#fbf1de', '#6d4709'),   # caveat
    'plain': ('#8d97a5', '#f6f8fa', '#5f6b7a'),   # neutral
}

def esc(s):
    return escape(str(s), quote=False)

def box(x, y, w, h, title, subs=(), kind='plain', align='start', dash=False, tsize=13):
    a, bg, dk = K[kind]
    need = (21 + 16 + 13 * (len(subs) - 1) + 8) if subs else 34
    h = max(h, need)
    d = ' stroke-dasharray="5 4"' if dash else ''
    tx = x + 14 if align == 'start' else x + w / 2
    anchor = 'start' if align == 'start' else 'middle'
    o = [f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="9" fill="{bg}" stroke="{a}" stroke-width="1.3"{d}/>']
    o.append(f'<text x="{tx}" y="{y+21}" text-anchor="{anchor}" font-size="{tsize}" font-weight="600" fill="{dk}">{esc(title)}</text>')
    yy = y + 21 + 16
    for s in subs:
        mono = s.startswith('`')
        s2 = s[1:] if mono else s
        fam = ' font-family="DejaVu Sans Mono, monospace"' if mono else ''
        size = 8.3 if mono else 9.6
        o.append(f'<text x="{tx}" y="{yy}" text-anchor="{anchor}" font-size="{size}"{fam} fill="#5f6b7a">{esc(s2)}</text>')
        yy += 13
    return '\n'.join(o)

def label(x, y, s, size=10, fill='#5f6b7a', anchor='start', weight='400', mono=False, style=''):
    fam = ' font-family="DejaVu Sans Mono, monospace"' if mono else ''
    st = f' font-style="{style}"' if style else ''
    return (f'<text x="{x}" y="{y}" text-anchor="{anchor}" font-size="{size}" font-weight="{weight}" '
            f'fill="{fill}"{fam}{st}>{esc(s)}</text>')

def arrow(x1, y1, x2, y2, color='#8d97a5', dash=False, w=1.5, marker='arrow'):
    d = ' stroke-dasharray="5 4"' if dash else ''
    return (f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{color}" stroke-width="{w}"{d} '
            f'marker-end="url(#{marker})"/>')

def path(d, color='#8d97a5', dash=False, w=1.5, marker='arrow'):
    da = ' stroke-dasharray="5 4"' if dash else ''
    m = f' marker-end="url(#{marker})"' if marker else ''
    return f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{w}"{da}{m}/>'

DEFS = '''<defs>
<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
  <path d="M0 0 L10 5 L0 10 z" fill="#8d97a5"/></marker>
<marker id="arrowT" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
  <path d="M0 0 L10 5 L0 10 z" fill="#0d7268"/></marker>
<marker id="arrowH" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
  <path d="M0 0 L10 5 L0 10 z" fill="#a32f4d"/></marker>
<marker id="arrowP" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
  <path d="M0 0 L10 5 L0 10 z" fill="#4a5a70"/></marker>
</defs>'''

def svg(vw, vh, body, cls='dia'):
    return f'<svg class="{cls}" viewBox="0 0 {vw} {vh}" xmlns="http://www.w3.org/2000/svg">{DEFS}{body}</svg>'

PAGES = []

def page(kicker, title, body, n):
    PAGES.append(f'''<section class="page">
  <header class="ph"><span class="kick">{kicker}</span><h2>{esc(title)}</h2></header>
  {body}
  <footer class="pf"><span>spendapp — end-to-end encryption</span><span>{n}</span></footer>
</section>''')

# ==========================================================================
# PAGE 1 — cover
# ==========================================================================
mini = []
_xs = [0, 138, 276, 414, 552, 690, 828]
_names = [('Password', 'hum'), ('Master key', 'sec'), ('KEK', 'sec'), ('Identity key', 'sec'),
          ('Epoch key', 'sec'), ('Entry key', 'sec'), ('Expense', 'ct')]
for i, (nm, kd) in enumerate(_names):
    mini.append(box(_xs[i], 20, 122, 42, nm, (), kd, align='mid', tsize=11.5))
    if i:
        mini.append(arrow(_xs[i] - 15, 41, _xs[i] - 2, 41))
MINI = svg(950, 76, '\n'.join(mini), cls='dia mini')

COVER = f'''<section class="page cover">
  <div class="cov-rule"></div>
  <p class="cov-kick">spendapp · design §4</p>
  <h1>How the cryptography flows<br><span>from a password to an expense</span></h1>
  <p class="cov-lede">Six keys stand between the word somebody types and the row a database holds.
  Each one is opened by the one before it, and only the last one opens an expense. This document
  follows that chain end to end — where every key comes from, what binds it to the thing it opens,
  and what the server is holding while it happens.</p>
  {MINI}
  <div class="cov-grid">
    <div><h4>What is on these pages</h4>
      <ol class="toc">
        <li><span>The spine</span> password → expense, in one picture</li>
        <li><span>Account keys</span> register, log in, unlock, change password</li>
        <li><span>Group keys</span> epochs, wrapping, rotation, the keyring</li>
        <li><span>The envelope</span> how one expense is sealed</li>
        <li><span>Trust anchors</span> what stops the server handing over its own key</li>
        <li><span>Reference</span> every domain string and every AAD</li>
      </ol></div>
    <div><h4>Reading the colours</h4>
      <ul class="legend">
        <li><i class="sw sec"></i><b>Secret, device only</b> — never sent anywhere, in any form</li>
        <li><i class="sw ct"></i><b>Ciphertext</b> — the server stores it and cannot open it</li>
        <li><i class="sw pub"></i><b>Public or server-held</b> — the metadata routing needs</li>
        <li><i class="sw hum"></i><b>Out of band</b> — a person, reading digits aloud</li>
      </ul>
      <h4 class="mt2">Primitives</h4>
      <p class="small">Argon2id (<code>hash-wasm</code>) and X25519 (<code>@noble/curves</code>)
      come from libraries because WebCrypto does not portably provide them. AES-GCM, HKDF-SHA-256
      and randomness are WebCrypto. Everything runs identically in the browser and in Node, so the
      tests exercise the same code paths the app does.</p>
    </div>
  </div>
  <p class="cov-quote">A database dump, a stolen backup or a curious operator reading tables gets
  ciphertext. What stays readable is the metadata the server must route on: who is in which group,
  entry counts, sizes and timestamps.</p>
  <footer class="pf cov-pf"><span>packages/shared/src/crypto.ts · apps/web/src/{{keys,groupKeys,entryKeys,envelope,aad}}.ts</span><span>1</span></footer>
</section>'''
PAGES.append(COVER)

# ==========================================================================
# PAGE 2 — the spine
# ==========================================================================
b = []
NX, NW = 34, 372          # node column
OX, OW = 442, 296         # operation column
SX, SW = 762, 238         # server column
PITCH, NH = 74, 50
top = 52

b.append(label(NX, 30, 'ON THE DEVICE', 9.5, '#8d97a5', weight='700'))
b.append(label(OX, 30, 'THE OPERATION', 9.5, '#8d97a5', weight='700'))
b.append(label(SX, 30, 'WHAT THE SERVER HOLDS OF IT', 9.5, '#8d97a5', weight='700'))
b.append(f'<line x1="{NX}" y1="36" x2="1000" y2="36" stroke="#d5dbe3" stroke-width="1"/>')
b.append(f'<rect x="{SX-14}" y="44" width="{SW+14}" height="{top-44+6*PITCH+NH+10}" rx="10" fill="#fafbfc" stroke="#e4e9ef"/>')

def row(i):
    return top + i * PITCH

nodes = [
    ('Password',            ('what the person knows — the only input',), 'hum'),
    ('Master key',          ('32 bytes, held in memory, stored nowhere',), 'sec'),
    None,                                       # split row, drawn by hand
    ('Identity private key', ('X25519, 32 bytes · one per account, for life',), 'sec'),
    ('Group epoch key',     ('32 random bytes · one per group, per epoch',), 'sec'),
    ('Entry key',           ('32 random bytes · one per expense or payment',), 'sec'),
    ('Expense content',     ('description, category, note, date, currency,', 'amount, rate, split metadata, every split'), 'ct'),
]
for i, n in enumerate(nodes):
    if n is None:
        continue
    t, s, k = n
    h = NH if len(s) < 2 else NH + 12
    b.append(box(NX, row(i), NW, h, t, s, k))

# row 2 (index 2): the split
y2 = row(2)
b.append(box(NX, y2, 178, NH, 'KEK', ('never leaves the device',), 'sec'))
b.append(box(NX + 194, y2, 178, NH, 'authKey', ('sent, and only this',), 'pub'))

ops = [
    (0, 'Argon2id', ['m = 19 MiB · t = 2 · p = 1 · 32-byte output',
                     '`salt: 16 random bytes, made at registration']),
    (1, 'HKDF-SHA-256, twice', ['empty salt — the domain lives in the info string',
                                '`spendapp/auth/v1 → authKey   ·   spendapp/wrap/v1 → KEK']),
    (2, 'AES-GCM open, under the KEK', ['the identity private key, sealed at registration',
                                        '`users.wrapped_private_key']),
    (3, 'X25519 ECDH → HKDF → AES-GCM open', ['one wrap per member per epoch, ephemeral sender key',
                                              '`info: spendapp/wrap-key/v1|epk|recipient']),
    (4, 'AES-GCM open, under the epoch key', ['the wrapper rides on the entry’s own row',
                                              '`aad: entrykey|expense|id|group|epoch']),
    (5, 'AES-GCM open, under the entry key', ['the tag is bound to the row it was written into',
                                              '`aad: expense|id|group|epoch']),
]
for i, title, lines in ops:
    ytop = row(i) + (NH if i != 6 else NH)
    ycen = ytop + (PITCH - NH) / 2
    # spine arrow
    sx = NX + (89 if i in (1, 2) else NW / 2)
    b.append(arrow(sx, ytop + 3, sx, row(i + 1) - 4, '#0d7268', marker='arrowT'))
    b.append(f'<line x1="{OX-24}" y1="{ycen-13}" x2="{OX-24}" y2="{ycen+16}" stroke="#0d7268" stroke-width="2"/>')
    b.append(label(OX - 12, ycen - 2, title, 10.4, '#0a5a52', weight='600'))
    yy = ycen + 11
    for ln in lines:
        mono = ln.startswith('`')
        b.append(label(OX - 12, yy, ln[1:] if mono else ln, 8.4 if mono else 9.2, '#66717f', mono=mono))
        yy += 11

# HKDF split fan
b.append(path(f'M {NX+89} {row(1)+NH+9} L {NX+283} {row(1)+NH+9} L {NX+283} {y2-4}',
              '#4a5a70', marker='arrowP'))

server = [
    (0, 'Nothing. Not now, not ever.', 'The password is not sent, hashed or otherwise.', 'hum'),
    (1, 'Nothing.', 'It exists only while the app is unlocked.', 'sec'),
    (2, 'argon2id(authKey) — a hash of a', 'derived key, not of the password.  users.password_hash', 'pub'),
    (3, 'Only the sealed copy, plus the', 'X25519 public half it publishes to the group.', 'ct'),
    (4, 'Only wraps: one blob per member,', 'openable by that member’s private key alone.', 'ct'),
    (5, 'Only the wrapper, sealed under an', 'epoch key it does not have.  key_iv / key_ct', 'ct'),
    (6, 'iv + ct, padded to a size bucket,', 'plus who wrote it, when, and in which group.', 'ct'),
]
for i, l1, l2, k in server:
    a, bg, dk = K[k]
    y = row(i) + 14
    b.append(f'<circle cx="{SX-2}" cy="{y-4}" r="3.4" fill="{a}"/>')
    b.append(label(SX + 10, y, l1, 9.4, '#39465a', weight='600'))
    b.append(label(SX + 10, y + 12, l2, 9.0, '#66717f'))

BODY = f'''{svg(1000, row(6) + 70, chr(10).join(b))}
<p class="cap"><b>The rule the whole design turns on:</b> the split at step two is one-way in both
directions. The server is given <code>authKey</code> and stores only an Argon2id hash of it; the
<code>KEK</code> — the half that actually unlocks anything — never leaves. Knowing either one tells
you nothing about the other, so a database dump holds no value that opens the row below it.</p>'''
page('01 — the spine', 'From a password to an expense', BODY, 2)

# ==========================================================================
# PAGE 3 — account keys
# ==========================================================================
def flow(y, name, note, steps, lane_h=58, tsize=13):
    o = [label(0, y + 20, name, 11.5, '#161b22', weight='700'),
         label(0, y + 34, note, 8.8, '#8d97a5')]
    x = 124
    for i, (w, t, subs, k) in enumerate(steps):
        o.append(box(x, y, w, lane_h, t, subs, k, tsize=tsize))
        if i < len(steps) - 1:
            o.append(arrow(x + w + 2, y + lane_h / 2, x + w + 14, y + lane_h / 2))
        x += w + 16
    return '\n'.join(o), x

b = []
LY, LP = 24, 86
W = (152, 130, 142, 176, 206)
b.append(flow(LY, 'Register', 'a brand-new account', [
    (W[0], 'Password + new salt', ('16 random bytes',), 'hum'),
    (W[1], 'Argon2id', ('→ master key',), 'plain'),
    (W[2], 'HKDF splits it', ('authKey · KEK',), 'sec'),
    (W[3], 'New X25519 keypair', ('private sealed under KEK',), 'sec'),
    (W[4], 'POST /auth/register', ('authKey, salt, params, public key,', 'sealed private key'), 'pub'),
], tsize=11.5)[0])
b.append(flow(LY + LP, 'Log in', 'a device with no keys yet', [
    (W[0], 'POST /auth/params', ('username in the body —', 'a path would land in logs'), 'pub'),
    (W[1], 'Argon2id', ('with that salt',), 'plain'),
    (W[2], 'HKDF splits it', ('authKey · KEK',), 'sec'),
    (W[3], 'POST /auth/login', ('argon2 verify, session cookie',), 'pub'),
    (W[4], 'KEK opens the private key', ('cached in IndexedDB so the app', 'works offline from cold'), 'sec'),
], tsize=11.5)[0])
b.append(flow(LY + 2 * LP, 'Unlock', 'a second browser', [
    (W[0], 'Signed in, no keys', ('but it decrypts nothing',), 'pub'),
    (W[1], 'Password again', ('the only thing that', 'reproduces the KEK'), 'hum'),
    (W[2], 'HKDF splits it', ('the KEK is what matters',), 'sec'),
    (W[3], 'GET /api/me', ('the sealed private key',), 'pub'),
    (W[4], 'GCM catches a wrong one', ('no KEK is ever cached that', 'opens nothing'), 'sec'),
], tsize=11.5)[0])
b.append(flow(LY + 3 * LP, 'Change password', 'the identity keypair stays', [
    (W[0], 'Prove the old one', ('the password, not just', 'the session'), 'hum'),
    (W[1], 'Fresh master key', ('new authKey, new KEK',), 'plain'),
    (W[2], 'Re-seal the key', ('the same identity key,', 'under the new KEK'), 'sec'),
    (W[3], 'POST /auth/rekey', ('carries currentAuthKey too',), 'pub'),
    (W[4], 'The identity cannot change', ('every group key is wrapped to it —', 'a new one would orphan the lot'), 'warn'),
], tsize=11.5)[0])

BODY = f'''{svg(1000, LY + 4 * LP + 14, chr(10).join(b))}
<div class="cols2">
<div class="panel"><h4>The <code>users</code> row, in full</h4>
<table class="t"><tbody>
<tr><td><code>password_hash</code></td><td>Argon2id of <b>authKey</b> — a hash of a derived key. The password itself was never in the request.</td></tr>
<tr><td><code>kdf_salt</code>, <code>kdf_params</code></td><td>Public by necessity: a client cannot re-derive without them. Stored per account, so raising the cost later does not invalidate old accounts.</td></tr>
<tr><td><code>public_key</code></td><td>The X25519 public half. Published to the group — this is what group keys get wrapped to.</td></tr>
<tr><td><code>wrapped_private_key</code></td><td>The private half, AES-GCM under the KEK. Opaque to the server for as long as it does not know the password.</td></tr>
</tbody></table></div>
<div class="panel"><h4>Two details that are easy to miss</h4>
<p class="small"><b>The username oracle.</b> Login is a two-step handshake, so <code>/auth/params</code> would say
whether an account exists. An unknown name instead gets a decoy: <code>HMAC-SHA256(server secret, name)</code>,
stable across requests, shaped exactly like a real salt, and useless — no <code>authKey</code> derived from it
will ever match. Unknown passwords are verified against a dummy hash so the timing matches too.</p>
<p class="small"><b>A forgotten password loses the data.</b> There is no reset and deliberately no recovery
code: the KEK exists nowhere but in the password. A <i>shared</i> group survives socially — another member
re-wraps its keys to a fresh account, which is what the join flow already does. A group of one does not.</p>
</div></div>
<p class="cap"><b>Where these keys sit once they are derived:</b> the unwrapped KEK and identity keypair
are cached in IndexedDB, so the app opens its own data offline from a cold start rather than demanding
the password and an Argon2id run on every launch — which protects the data on the server, not on an
unlocked stolen phone. The password itself lives inside one module for the length of one call, and
nowhere else.</p>'''
page('02 — account keys', 'Where the account’s two keys come from, and what survives a password change', BODY, 3)

# ==========================================================================
# PAGE 4 — group keys
# ==========================================================================
b = []
# -- left: wrapping an epoch key to a member
b.append(label(0, 16, 'HOW AN EPOCH KEY REACHES A MEMBER', 9.5, '#8d97a5', weight='700'))
b.append(f'<line x1="0" y1="22" x2="470" y2="22" stroke="#d5dbe3"/>')
b.append(box(0, 34, 214, 46, 'Group epoch key', ('32 random bytes',), 'sec'))
b.append(box(256, 34, 214, 46, 'Member’s X25519 public key', ('published by the server',), 'pub'))
b.append(box(0, 104, 214, 58, 'Fresh ephemeral keypair', ('one per wrap — the same key,', 'twice, gives unrelated blobs'), 'sec'))
b.append(arrow(107, 82, 107, 100))
b.append(box(90, 190, 290, 46, 'X25519 ECDH → HKDF-SHA-256', ('`info: spendapp/wrap-key/v1|epk|recipient',), 'plain', align='mid'))
b.append(path('M 363 82 L 363 174 L 300 174 L 300 186', '#4a5a70', marker='arrowP'))
b.append(path('M 107 164 L 107 174 L 170 174 L 170 186', '#0d7268', marker='arrowT'))
b.append(box(20, 264, 430, 58, 'AES-GCM seal — { epk, iv, ct }', ('one row in group_keys per member, per epoch — and both public keys', 'are in the info, so a wrap cannot be replayed at somebody else'), 'ct', align='mid'))
b.append(arrow(235, 240, 235, 260))

# -- right: the keyring
RX = 530
b.append(label(RX, 16, 'THE KEYRING A MEMBER HOLDS', 9.5, '#8d97a5', weight='700'))
b.append(f'<line x1="{RX}" y1="22" x2="1000" y2="22" stroke="#d5dbe3"/>')
epochs = [('epoch 0', 'minted here — group creation', True),
          ('epoch 1', 'chained to 0 — proved', True),
          ('epoch 2', 'chained to 1 — proved', True),
          ('epoch 3', 'no proof — readable, not writable', False)]
for i, (e, why, tr) in enumerate(epochs):
    y = 34 + i * 46
    k = 'sec' if tr else 'warn'
    a, bg, dk = K[k]
    b.append(f'<rect x="{RX}" y="{y}" width="336" height="36" rx="8" fill="{bg}" stroke="{a}" stroke-width="1.2"/>')
    b.append(label(RX + 13, y + 16, e, 11, dk, weight='600'))
    b.append(label(RX + 13, y + 28, why, 8.8, '#66717f'))
    b.append(label(RX + 348, y + 22, 'trusted' if tr else 'untrusted', 9.2, dk, weight='600'))
    if i:
        b.append(f'<path d="M {RX+24} {y-12} L {RX+24} {y-3}" stroke="#0d7268" stroke-width="1.4" marker-end="url(#arrowT)"/>')
b.append(box(RX, 232, 460, 88, 'Two rules, and they are different on purpose',
             ('Read with any key held — old entries and unproved epochs stay legible.',
              'Write only under the highest trusted epoch — a server that invents an',
              'epoch wants new entries sealed under it, and refusing is what makes that',
              'pointless. Rotation is forward-only: it never claws back the past.'), 'plain'))

BODY = f'''{svg(1000, 324, chr(10).join(b))}
<div class="cols3">
<div class="panel"><h4>Three ways an epoch arrives</h4>
<p class="small"><b>Minted.</b> Epoch 0 is generated on the creator’s device and travels inside the
create-group request, so a group cannot exist without a key its creator can open.</p>
<p class="small"><b>Handed over.</b> An approving member wraps the whole keyring to the joiner — wrapping
only the current epoch would hand them a group that looks empty up to the last rotation. A
<i>from-today</i> invite hands over one epoch instead, and that is what history scoping <i>is</i>.</p>
<p class="small"><b>Rotated.</b> After a removal, a new epoch is minted and wrapped to whoever remains.</p>
</div>
<div class="panel"><h4>The chain proof</h4>
<p class="small">A rotation seals the new key <i>under the epoch it replaces</i>:</p>
<p class="mono sm">seal(key<sub>n-1</sub>, key<sub>n</sub>,<br>&nbsp;&nbsp;aad = spendapp/key-chain/v1|group|n)</p>
<p class="small">Producing that takes a member who already holds the old key. The server holds wraps
it cannot open, so it cannot mint an epoch a client will write under. An <i>absent</i> proof is not a
lie — epoch 0 has none, and neither does the floor of a scoped ring. A proof that is present and
<i>wrong</i> is somebody claiming a lineage they do not have, and the epoch is dropped.</p>
</div>
<div class="panel"><h4>What rotation touches</h4>
<p class="small">The new epoch is wrapped to every remaining member, and the group’s <b>name</b> is
re-sealed under it — somebody admitted on this epoch alone has no other key to read it with. Minting is
server-arbitrated (<code>mint: true</code>) so two admins removing people at once cannot both claim the
same epoch number.</p>
<p class="small">Entries already written do not move. Their epoch key still opens them, and the member
who left keeps every key and every entry already on their device — re-encrypting the past would not
change that.</p>
</div></div>'''
page('03 — group keys', 'Epochs, wrapping, rotation, and the ring a member ends up holding', BODY, 4)

# ==========================================================================
# PAGE 5 — the envelope
# ==========================================================================
b = []
b.append(box(0, 30, 196, 86, 'The expense, in plaintext',
             ('description · category · note', 'date · currency · amount', 'rate · split metadata · splits'), 'plain'))
b.append(arrow(200, 73, 216, 73))
b.append(box(220, 30, 176, 86, 'validateSplits',
             ('Σ paid = Σ owed = amount.', 'The server cannot check this', 'any more, so this is the last', 'place a corrupt split stops.'), 'hum'))
b.append(arrow(400, 73, 416, 73))
b.append(box(420, 30, 186, 86, 'currentEpoch(group)',
             ('the highest trusted epoch,', 'and its key. No key, no write —', 'the entry stays queued rather', 'than going out readable.'), 'sec'))
b.append(arrow(610, 73, 626, 73))
b.append(box(630, 30, 186, 86, 'mintEntryKey',
             ('32 random bytes, or the key', 'this device already used for', 'this entry — replacing it would', 'break every grant issued on it.'), 'sec'))

# three seals fanning out
b.append(path('M 723 120 L 723 138 L 150 138 L 150 158', '#0d7268', marker='arrowT'))
b.append(path('M 723 120 L 723 138 L 500 138 L 500 158', '#0d7268', marker='arrowT'))
b.append(path('M 723 120 L 723 138 L 850 138 L 850 158', '#0d7268', marker='arrowT'))
b.append(box(0, 162, 300, 84, '① The content, under the entry key',
             ('`sealJson(entryKey, content,', '`  aad = expense|<id>|<group>|<epoch>)',
              'JSON is padded with trailing spaces to', '256 / 512 / 1 KiB / 2 KiB / 4 KiB first.'), 'ct'))
b.append(box(350, 162, 300, 84, '② The entry key, under the epoch key',
             ('`seal(epochKey, entryKey,', '`  aad = entrykey|expense|<id>|<group>|<epoch>)',
              'Rides on the entry’s own row, so an ordinary', 'member reads exactly as they always did.'), 'ct'))
b.append(box(700, 162, 300, 84, '③ A snapshot, under the epoch key',
             ('`sealJson(epochKey, input,', '`  aad = snapshot|<activityId>|<group>|<epoch>)',
              'Every write carries one, so the audit log can', 'offer “revert to this” without the server reading it.'), 'ct'))
b.append(path('M 150 250 L 150 264 L 500 264 L 500 278', '#4b46a6', marker='arrow'))
b.append(path('M 500 250 L 500 278', '#4b46a6', marker='arrow'))
b.append(path('M 850 250 L 850 264 L 500 264', '#4b46a6', marker=None))
b.append(box(230, 282, 540, 46, 'What the row actually holds',
             ('`id · group_id · key_epoch · iv · ct · key_iv · key_ct · created_by · updated_at · deleted_at',), 'pub', align='mid'))

BODY = f'''{svg(1000, 336, chr(10).join(b))}
<div class="cols2 tight">
<div class="panel"><h4>Everything sealed, and what seals it</h4>
<table class="t"><thead><tr><th>What</th><th>Sealed under</th><th>Bound to (AAD)</th></tr></thead><tbody>
<tr><td>Expense / payment content</td><td>its own entry key</td><td><code>expense|id|group|epoch</code></td></tr>
<tr><td>The entry key itself</td><td>the epoch key</td><td><code>entrykey|type|id|group|epoch</code></td></tr>
<tr><td>Version snapshot</td><td>the epoch key</td><td><code>snapshot|activityId|group|epoch</code></td></tr>
<tr><td>Comment</td><td>the epoch key</td><td><code>comment|id|group|epoch</code></td></tr>
<tr><td>Receipt image</td><td>the epoch key</td><td><code>attachment|id|group|epoch</code></td></tr>
<tr><td>Group name</td><td>the <i>newest</i> epoch key</td><td><code>groupname|group|epoch</code></td></tr>
</tbody></table>
<p class="small">The AAD is authenticated but not encrypted, so it costs nothing to store and a blob
lifted from one row into another simply will not open. Two versions of one expense would otherwise
share an AAD and could be swapped — which is why a snapshot is bound to its own log row, not to the
entry.</p></div>
<div class="panel"><h4>Three consequences of doing it this way</h4>
<p class="small"><b>Length is a leak, so it is bucketed.</b> AES-GCM does not hide size: the exact byte
count of a row separates a two-way split from a ten-way one and a one-word note from a paragraph.
Padding is trailing spaces, which <code>JSON.parse</code> already ignores, so nothing stored had to move
when it was introduced. It stops at 4 KiB, where a record gives away only that it is large.</p>
<p class="small"><b>A receipt is a file, not a row.</b> The IV rides in front of the ciphertext instead of
in a column, so the two can never be separated or mispaired. The image type is sniffed on the device
when it comes back — the server never sees enough to know it was ever an image.</p>
<p class="small"><b>The outbox re-seals on the way out.</b> A device that was offline when the group
rotated has mutations sealed under the old epoch. Re-sealing at upload time is byte-level: the
plaintext is opened and sealed again exactly as it is, only the AAD changes, and the result is opened
once more and compared before the queued copy — the only copy — is replaced.</p>
</div></div>'''
page('04 — the envelope', 'What happens to one expense between the form and the database row', BODY, 5)

# ==========================================================================
# PAGE 6 — trust anchors
# ==========================================================================
b = []
b.append(label(0, 16, 'A · JOINING — THE DIGITS BOTH SIDES READ ALOUD', 9.5, '#8d97a5', weight='700'))
b.append(f'<line x1="0" y1="22" x2="1000" y2="22" stroke="#d5dbe3"/>')
b.append(box(0, 32, 176, 72, 'Invite link', ('128-bit token, carried in the', 'URL fragment — never sent to', 'a server, never in a log'), 'pub'))
b.append(arrow(180, 68, 196, 68))
b.append(box(200, 32, 168, 72, 'Server stores sha256', ('of the token, so neither side', 'holds what the other has'), 'pub'))
b.append(arrow(372, 68, 388, 68))
b.append(box(392, 32, 216, 72, 'Both sides derive the SAS', ('`HKDF(tokenHash | joinerPubKey | groupId,',
                                                               '`     info spendapp/sas/v2, 8 bytes)'), 'hum'))
b.append(arrow(612, 68, 628, 68))
b.append(box(632, 32, 168, 72, '20 digits, read aloud', ('64 bits. Long because nothing', 'commits to the key first — six', 'digits fell to a collision in seconds'), 'hum'))
b.append(arrow(804, 68, 820, 68))
b.append(box(824, 32, 176, 72, 'Admin approves', ('and only then wraps the', 'keyring to that public key'), 'sec'))
b.append(label(0, 124, 'It authenticates the joiner’s public key to the admin — the direction that stops the wrong person being let in. It says nothing about the keys travelling back.', 9.2, '#8a5a10'))

b.append(label(0, 162, 'B · AFTERWARDS — WHAT THIS ACCOUNT ITSELF RECORDED', 9.5, '#8d97a5', weight='700'))
b.append(f'<line x1="0" y1="168" x2="1000" y2="168" stroke="#d5dbe3"/>')
b.append(box(0, 178, 210, 72, 'Identity private key', ('the half the server never', 'sees — and the half a', 'password change keeps'), 'sec'))
b.append(arrow(214, 214, 228, 214))
b.append(box(232, 178, 244, 72, 'Commitment key', ('`HKDF(idPrivKey,', '`  spendapp/key-commitment-key/v1)'), 'sec', tsize=12))
b.append(arrow(480, 214, 494, 214))
b.append(box(498, 178, 300, 72, 'seal( fingerprint of the key )', ('`fingerprint = HKDF(key, spendapp/key-fingerprint/v1)',
                                                                     '`aad = spendapp/key-commitment/v1|group|epoch|user'), 'ct', tsize=12))
b.append(arrow(802, 214, 816, 214))
b.append(box(820, 178, 180, 72, 'Stored by the server', ('which can neither read', 'one nor forge one — that', 'is what makes it evidence'), 'pub'))
b.append(label(0, 270, 'On a second device, or one whose cache was cleared: a delivered key that contradicts this account’s own commitment is refused outright — not merely held untrusted — and the member is told which epoch.', 9.2, '#a32f4d'))

BODY = f'''{svg(1000, 284, chr(10).join(b))}
<div class="cols3">
<div class="panel"><h4>Why a commitment beats a wrap</h4>
<p class="small">A wrap arrives sealed to a public key <i>the server itself publishes</i>, so nothing in
it says a member produced it. A commitment is sealed under a key only this account’s devices can derive.
So it is the one thing in a sync payload that is a statement <i>by us</i>, made at a time we held the
real key, about what that key was.</p>
<p class="small">Derived from the identity private key rather than the KEK on purpose: a new password
means a new KEK, and every commitment this account had ever written would become unopenable and
unreplaceable — the anchor silently gone on the next fresh device.</p></div>
<div class="panel"><h4>Two numbers members compare by voice</h4>
<p class="small"><b>Epoch digits.</b> Over the newest epoch held, named alongside the epoch so two people
compare like with like rather than reading a mismatch out of one being a sync behind. Every current
member holds the newest epoch by construction, so this number is comparable across the whole group.</p>
<p class="small"><b>Keyring digits.</b> Strictly stronger where they apply — they cover every key a
hand-over delivered, including the oldest held, which has no predecessor to chain to. But two honest
rings differ whenever history differs, so these are offered only when the server reports that every
member holds every epoch. It can lie about that; the worst it buys is a false alarm.</p></div>
<div class="panel"><h4>The gap that is left, stated plainly</h4>
<p class="small">The very first key a brand-new account is given is still taken on trust. The ring is
empty, so there is no predecessor to chain to and no commitment of this account’s to contradict. A
server substituting the key at that moment reads everything the member writes afterwards.</p>
<p class="small">Reading the digits aloud, once, is the only thing standing in the way — and every
delivery after that is anchored, by the chain, by the commitment, or by both.</p>
<p class="small"><b>And it protects the server, not the phone.</b> Keys are cached unwrapped in IndexedDB
so the app works offline from a cold start.</p></div></div>
<div class="panel strip"><h4>The three anchors, in the order they are checked</h4>
<div class="cols3 nogap">
<p class="small"><b>1 · This account’s own commitment.</b> A delivered key whose fingerprint disagrees
is <i>refused</i> — no honest party can produce one — and accepted without needing a chain, because our
own past word is a better anchor than a proof.</p>
<p class="small"><b>2 · The chain proof.</b> Present and correct: trusted. Present and wrong: the epoch
is <i>dropped</i>. Absent: held, readable, but never written under — epoch 0 and the floor of a scoped
ring legitimately have none.</p>
<p class="small"><b>3 · The hand-over itself.</b> The one delivery trusted unconditionally, because the
ring is empty and there is nothing to check it against. This is where the digits read aloud, and
nothing else, are doing the work.</p>
</div></div>'''
page('05 — trust anchors', 'What stops the server from handing over a key of its own', BODY, 6)

# ==========================================================================
# PAGE 7 — reference
# ==========================================================================
BODY = '''<div class="cols2 ref">
<div>
<div class="panel"><h4>Domain separation — every HKDF <code>info</code> string</h4>
<p class="small">The salt is empty everywhere: the input is already a high-entropy Argon2id output or an
ECDH secret, and the separation lives entirely here. No two uses of the same key material can collide.</p>
<table class="t mono-l"><tbody>
<tr><td><code>spendapp/auth/v1</code></td><td>master key → authKey</td></tr>
<tr><td><code>spendapp/wrap/v1</code></td><td>master key → KEK</td></tr>
<tr><td><code>spendapp/wrap-key/v1|epk|recipient</code></td><td>ECDH secret → the key that wraps a group or entry key</td></tr>
<tr><td><code>spendapp/key-fingerprint/v1</code></td><td>epoch key → a one-way name for it, safe to store</td></tr>
<tr><td><code>spendapp/key-commitment-key/v1</code></td><td>identity private key → the commitment key</td></tr>
<tr><td><code>spendapp/sas/v2</code></td><td>token hash + joiner key + group → 20 join digits</td></tr>
<tr><td><code>spendapp/epoch-sas/v1</code></td><td>group + epoch + fingerprint → 20 digits</td></tr>
<tr><td><code>spendapp/keyring-sas/v1</code></td><td>group + the whole ring → 20 digits</td></tr>
</tbody></table></div>
<div class="panel"><h4>Every AAD, and what it prevents</h4>
<table class="t mono-l"><tbody>
<tr><td><code>expense|id|group|epoch</code></td><td rowspan="2">A blob cannot be lifted from one row and replayed into another.</td></tr>
<tr><td><code>payment|id|group|epoch</code></td></tr>
<tr><td><code>entrykey|type|id|group|epoch</code></td><td>Where “this entry belongs to that epoch” is actually authenticated.</td></tr>
<tr><td><code>snapshot|activityId|group|epoch</code></td><td>Two versions of one expense cannot be swapped for each other.</td></tr>
<tr><td><code>comment|id|group|epoch</code></td><td>A comment cannot be moved to another entry.</td></tr>
<tr><td><code>attachment|id|group|epoch</code></td><td>A receipt cannot be moved to another expense.</td></tr>
<tr><td><code>groupname|group|epoch</code></td><td>Bound to the group and epoch only — so renaming is not a re-seal of everything.</td></tr>
<tr><td><code>spendapp/key-chain/v1|group|epoch</code></td><td>A rotation proof cannot be replayed at a different epoch.</td></tr>
<tr><td><code>spendapp/key-commitment/v1|group|epoch|user</code></td><td>The server cannot move a commitment between epochs or users.</td></tr>
</tbody></table></div>
</div>
<div>
<div class="panel"><h4>What a database dump contains</h4>
<div class="two-up">
<div><h5 class="ok">Opaque</h5><ul class="tick">
<li>Every expense and payment: amounts, currencies, descriptions, notes, categories, dates, and who owes whom</li>
<li>Every comment</li>
<li>Every receipt image</li>
<li>Every group name</li>
<li>Every version snapshot in the audit trail</li>
<li>Every group key, entry key and identity private key</li>
</ul></div>
<div><h5 class="no">Readable — the metadata routing needs</h5><ul class="tick no">
<li>Who is in which group, and who is an admin</li>
<li>How many entries exist, roughly how large, and when each was written or changed</li>
<li>Which account wrote which row</li>
<li>Display names, usernames, session and push-subscription records</li>
<li>Which epoch each row belongs to, and who holds a wrap for it</li>
</ul></div></div>
<p class="small mt">The release check is one line, and it is the only test of the actual claim:
<code class="blk">mysqldump spendapp &gt; /tmp/check.sql &amp;&amp; grep -i 'a description you know is in there' /tmp/check.sql</code>
It must find nothing. The server test suite pins the sealed tables to explicit column lists, so a
plaintext column reappearing fails in CI rather than in the dump.</p>
</div>
<div class="panel"><h4>What this costs, deliberately</h4>
<p class="small"><b>The server validates no money.</b> It cannot see a split, so a modified client can
write a corrupt entry into a shared group. Clients check on read and refuse it, and the group is told
which entry and who wrote it.</p>
<p class="small"><b>No server-side search, reporting or aggregation</b>, permanently.</p>
<p class="small"><b>Notifications fan out to everybody.</b> Sending only to the people an entry names
would mean telling the server who they are — the participant graph, which is worth more than the
notification it would buy. So every member’s device is woken by every entry and filters on arrival.</p>
<p class="small"><b>Download my data is built on the device.</b> The server holds ciphertext, so it could
never produce a readable copy, and an archive of ciphertext would not be portable in any useful sense.</p>
</div>
</div></div>'''
page('06 — reference', 'Every domain string, every binding, and what is left readable', BODY, 7)

# ==========================================================================
# shell
# ==========================================================================
CSS = '''
@page { size: A4 landscape; margin: 0; }
* { box-sizing: border-box; }
html, body { margin:0; padding:0; }
body { font-family:"Liberation Sans","DejaVu Sans",sans-serif; color:#161b22;
       -webkit-print-color-adjust:exact; print-color-adjust:exact; background:#fff; }
.page { width:297mm; height:210mm; padding:13mm 15mm 10mm; position:relative;
        page-break-after:always; overflow:hidden; }
.page:last-child { page-break-after:auto; }
.ph { border-bottom:2px solid #161b22; padding-bottom:5px; margin-bottom:11px; }
.kick { display:block; font-size:7.6pt; letter-spacing:.16em; text-transform:uppercase;
        color:#0d7268; font-weight:700; margin-bottom:2px; }
.ph h2 { font-family:"Bitstream Charter","DejaVu Serif",serif; font-size:16.5pt; font-weight:700;
         margin:0; letter-spacing:-.01em; }
.pf { position:absolute; left:15mm; right:15mm; bottom:6mm; display:flex; justify-content:space-between;
      font-size:7pt; color:#9aa4b0; border-top:1px solid #e4e9ef; padding-top:4px; }
svg.dia { display:block; width:100%; height:auto; }
svg.mini { width:82%; margin:14px 0 4px; }
.cap { font-size:8.6pt; line-height:1.45; color:#4b5563; margin:12px 0 0; max-width:none;
       border-left:3px solid #0d7268; padding-left:11px; }
.cap b { color:#161b22; }
.cols2, .cols3 { display:grid; gap:11px; margin-top:12px; }
.cols2 { grid-template-columns:1fr 1fr; }
.cols3 { grid-template-columns:1fr 1fr 1fr; }
.cols2.tight { margin-top:9px; }
.cols3.nogap { margin-top:2px; gap:14px; }
.panel.strip { margin-top:9px; padding:7px 11px 8px; }
.panel.strip h4 { margin-bottom:4px; font-size:8.8pt; }
.panel.strip .small { font-size:7.55pt; line-height:1.36; }
.panel { background:#fafbfc; border:1px solid #e4e9ef; border-radius:9px; padding:9px 11px 10px; }
.panel h4 { margin:0 0 6px; font-size:9.2pt; font-weight:700; color:#0a5a52;
            font-family:"Bitstream Charter","DejaVu Serif",serif; }
.panel h5 { margin:0 0 4px; font-size:7.8pt; letter-spacing:.05em; text-transform:uppercase; }
h5.ok { color:#0d7268; } h5.no { color:#4a5a70; }
.small { font-size:8.1pt; line-height:1.42; color:#4b5563; margin:0 0 5px; }
.small:last-child { margin-bottom:0; }
.small b { color:#161b22; } .small i { color:#374151; }
.mt { margin-top:7px; } .mt2 { margin-top:17px; }
.cov-quote { position:absolute; left:22mm; right:22mm; bottom:20mm; font-size:10pt; line-height:1.5;
             color:#374151; border-left:3px solid #0d7268; padding:2px 0 2px 11px; margin:0;
             font-family:"Bitstream Charter","DejaVu Serif",serif; }
code { font-family:"DejaVu Sans Mono",monospace; font-size:.88em; color:#3a3684;
       background:#f0effa; padding:.5px 3px; border-radius:3px; }
code.blk { display:block; margin:4px 0; padding:5px 7px; background:#f0effa; font-size:7.6pt; }
.mono { font-family:"DejaVu Sans Mono",monospace; }
.mono.sm { font-size:7.6pt; color:#3a3684; background:#f0effa; padding:5px 7px; border-radius:5px;
           line-height:1.5; margin:4px 0 6px; }
table.t { width:100%; border-collapse:collapse; font-size:7.7pt; line-height:1.34; }
table.t th { text-align:left; font-size:7pt; letter-spacing:.05em; text-transform:uppercase;
             color:#8d97a5; border-bottom:1px solid #d5dbe3; padding:0 6px 3px 0; font-weight:700; }
table.t td { vertical-align:top; padding:3.5px 6px 3.5px 0; border-bottom:1px solid #edf0f4; color:#4b5563; }
table.t tr:last-child td { border-bottom:none; }
table.t.mono-l td:first-child { width:44%; }
table.t td code { white-space:nowrap; }
.two-up { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
ul.tick { margin:0; padding:0; list-style:none; }
ul.tick li { font-size:7.7pt; line-height:1.32; color:#4b5563; padding-left:13px; position:relative; margin-bottom:3.5px; }
ul.tick li::before { content:"■"; position:absolute; left:0; color:#0d7268; font-size:6pt; top:1.5px; }
ul.tick.no li::before { content:"□"; color:#8d97a5; }
/* cover */
.cover { padding:20mm 22mm 10mm; }
.cov-rule { width:52mm; height:4px; background:#0d7268; margin-bottom:9mm; }
.cov-kick { font-size:8pt; letter-spacing:.2em; text-transform:uppercase; color:#8d97a5;
            margin:0 0 5mm; font-weight:700; }
.cover h1 { font-family:"Bitstream Charter","DejaVu Serif",serif; font-size:31pt; line-height:1.12;
            font-weight:700; margin:0 0 6mm; letter-spacing:-.015em; }
.cover h1 span { color:#0d7268; }
.cov-lede { font-size:10.5pt; line-height:1.5; color:#4b5563; max-width:168mm; margin:0; }
.cov-grid { display:grid; grid-template-columns:1fr 1fr; gap:16mm; margin-top:7mm; }
.cov-grid h4 { font-family:"Bitstream Charter","DejaVu Serif",serif; font-size:9.5pt; margin:0 0 5px;
               color:#161b22; border-bottom:1px solid #d5dbe3; padding-bottom:3px; }
ol.toc { margin:0; padding-left:15px; font-size:8.4pt; line-height:1.62; color:#6b7280; }
ol.toc span { color:#161b22; font-weight:700; }
ul.legend { margin:0; padding:0; list-style:none; font-size:8.4pt; line-height:1.5; color:#6b7280; }
ul.legend li { margin-bottom:3px; }
ul.legend b { color:#161b22; }
i.sw { display:inline-block; width:9px; height:9px; border-radius:2.5px; margin-right:6px; }
i.sw.sec { background:#e2f2ef; border:1.3px solid #0d7268; }
i.sw.ct  { background:#ecebfa; border:1.3px solid #4b46a6; }
i.sw.pub { background:#edf1f6; border:1.3px solid #4a5a70; }
i.sw.hum { background:#fbe9ee; border:1.3px solid #a32f4d; }
.cov-pf { left:22mm; right:22mm; }
'''

HTML = f'''<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>spendapp — cryptography flow</title><style>{CSS}</style></head>
<body>{''.join(PAGES)}</body></html>'''

import io, sys, os
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'crypto-flow.html')
with io.open(out, 'w', encoding='utf-8') as f:
    f.write(HTML)
print('wrote', out, len(HTML))
