#!/bin/sh
# Configures Postfix and OpenDKIM from the environment and runs both.
#   MAIL_DOMAIN    the domain mail is sent from (hello@MAIL_DOMAIN); also the HELO name unless
#                  MAIL_HOSTNAME is set. Reverse DNS of the server's address must point at it.
#   DKIM_SELECTOR  defaults to "kovan"; the key is created in /dkim on first start.
# The DNS records to publish are printed at every start (and by `entrypoint.sh dns`).
set -eu

: "${MAIL_DOMAIN:?MAIL_DOMAIN is not set}"
HOSTNAME_="${MAIL_HOSTNAME:-$MAIL_DOMAIN}"
SELECTOR="${DKIM_SELECTOR:-kovan}"
KEY="/dkim/$SELECTOR.private"
PRIVATE_NETS="127.0.0.0/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16"

if [ ! -f "$KEY" ]; then
  opendkim-genkey -b 2048 -d "$MAIL_DOMAIN" -s "$SELECTOR" -D /dkim
fi
chown opendkim:opendkim "$KEY"
chmod 600 "$KEY"

dns() {
  # The public key as one string (the generated file splits it into quoted chunks).
  pub="$(sed -e 's/^[^(]*(//' -e 's/).*$//' "/dkim/$SELECTOR.txt" | tr -d '"\n\t ' | sed 's/;/; /g')"
  echo "mail: DNS records for $MAIL_DOMAIN"
  echo "  TXT  $MAIL_DOMAIN                       v=spf1 a -all"
  echo "  TXT  $SELECTOR._domainkey.$MAIL_DOMAIN  $pub"
  echo "  TXT  _dmarc.$MAIL_DOMAIN                v=DMARC1; p=quarantine; adkim=s; aspf=s"
  echo "  PTR  <this server's address>            $HOSTNAME_"
}

if [ "${1:-}" = "dns" ]; then
  dns
  exit 0
fi

mkdir -p /etc/opendkim /run/opendkim
chown opendkim:opendkim /run/opendkim
printf '%s\n' $PRIVATE_NETS >/etc/opendkim/internal
cat >/etc/opendkim/opendkim.conf <<EOF
Mode                  s
Canonicalization      relaxed/relaxed
Domain                $MAIL_DOMAIN
Selector              $SELECTOR
KeyFile               $KEY
Socket                inet:8891@127.0.0.1
UserID                opendkim
InternalHosts         refile:/etc/opendkim/internal
OversignHeaders       From
Syslog                no
EOF

postconf -e \
  "compatibility_level = 3.6" \
  "myhostname = $HOSTNAME_" \
  "myorigin = $MAIL_DOMAIN" \
  "mydestination =" \
  "alias_maps =" \
  "alias_database =" \
  "local_recipient_maps =" \
  "inet_interfaces = all" \
  "inet_protocols = ipv4" \
  "mynetworks = $PRIVATE_NETS" \
  "smtpd_relay_restrictions = permit_mynetworks, reject" \
  "smtpd_sender_restrictions = check_sender_access inline:{ $MAIL_DOMAIN=OK }, reject" \
  "transport_maps = inline:{ $MAIL_DOMAIN=discard:no-inbox }" \
  "smtp_tls_security_level = may" \
  "smtp_tls_CAfile = /etc/ssl/certs/ca-certificates.crt" \
  "smtp_tls_loglevel = 1" \
  "smtpd_milters = inet:127.0.0.1:8891" \
  "non_smtpd_milters = inet:127.0.0.1:8891" \
  "milter_default_action = tempfail" \
  "maximal_queue_lifetime = 6h" \
  "bounce_queue_lifetime = 1h" \
  "notify_classes =" \
  "maillog_file = /dev/stdout"

dns
opendkim -x /etc/opendkim/opendkim.conf
exec postfix start-fg
