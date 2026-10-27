# pg_dump plus openssl, for deploy/backup.sh.
FROM postgres:17-alpine
RUN apk add --no-cache openssl
COPY backup.sh /backup.sh
ENTRYPOINT ["/bin/sh", "/backup.sh"]
CMD ["loop"]
