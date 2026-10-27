# Send-only mail for a self-hosted Kovan: Postfix with DKIM signing. It accepts mail only from
# the compose network, only from MAIL_DOMAIN, and receives nothing from the internet.
FROM alpine:3.22
RUN apk add --no-cache postfix opendkim opendkim-utils ca-certificates
COPY entrypoint.sh /entrypoint.sh
VOLUME ["/var/spool/postfix", "/dkim"]
EXPOSE 25
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD postfix status || exit 1
ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
