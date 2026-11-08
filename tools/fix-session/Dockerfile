FROM maven:3.9.11-eclipse-temurin-21@sha256:463a1849665463254b2dd56e3a5b316f1596bc93d0571065c06ea05bb48ab8f4 AS java-build
WORKDIR /build
COPY tools/fix-session/java/pom.xml ./
COPY tools/fix-session/java/src ./src
RUN mvn --batch-mode --no-transfer-progress test-compile dependency:copy-dependencies -DoutputDirectory=/out/lib && mkdir -p /out/proofs && java -cp target/classes:target/test-classes tradeflow.LiveEventsCheck > /out/proofs/java-live-events.txt && java -cp target/classes:target/test-classes tradeflow.ResponseGuardCheck > /out/proofs/java-guard.txt && java -cp 'target/classes:target/test-classes:/out/lib/*' tradeflow.CalendarCheck > /out/proofs/java-calendar.txt && mkdir -p /out/classes && cp -r target/classes/. /out/classes/

FROM golang:1.27.3-bookworm@sha256:025eefc1e8dbe63201734a72aaa0a55d7a077f2d8410432f8ae2f3e939f32871 AS go-build
WORKDIR /build
COPY verification/fix-peer/go/go.mod verification/fix-peer/go/go.sum ./
COPY verification/fix-peer/go/*.go ./
COPY tools/fix-session/calendar ./calendar
RUN mkdir -p /out && go test -mod=readonly -count=1 -timeout=60s -v . > /out/go-wrapper.txt && go test -mod=readonly -run '^(TestOrdinaryAndWrongIDCannotAnswerPendingRequest|TestCorrectResponseJustBeforeDeadlineClearsPendingRequest|TestResponseAtOrAfterDeadlineCannotReviveRequest|TestRepeatedRequestDoesNotMoveOriginalDeadline|TestCompetingRequestFailsClosedWithoutReplacingOriginal|TestInvalidRequestIDsAreRefused|TestStaleAndFutureSendingTimeCannotClearEvenAcceptedCallback|TestConnectionResetClearsPendingWithoutCreatingReceipt|TestWrapperRejectsStaleAcceptedHeartbeatForGuardAcknowledgment)$' -count=1 -timeout=60s -v . > /out/go-guard.txt && go run -mod=readonly ./calendar/overlay.go && GOWORK=/tmp/calendar.work go test -mod=readonly -run '^TestTradeFlowContinuousCalendarBoundary$' -count=1 -timeout=60s -v github.com/quickfixgo/quickfix > /out/go-calendar.txt && GOWORK=off CGO_ENABLED=0 go build -mod=readonly -trimpath -o /out/peer . && GOWORK=off go run -mod=readonly ./calendar/licenses.go

FROM eclipse-temurin:21-jre-jammy@sha256:d4cbe963bb4f3a769d56473b32db2bfb46b0d4b29797c152815da692d9f9aab5 AS java-runtime

FROM python:3.14-slim-bookworm@sha256:1faf2343e747208b2a36e5f2b5ff908ec3b2d0078a6a7bfe73b535698fe83909
COPY --from=java-runtime /opt/java/openjdk /opt/java/openjdk
COPY --from=go-build /usr/lib/x86_64-linux-gnu/libstdc++.so.6 /usr/lib/x86_64-linux-gnu/libstdc++.so.6
COPY --from=go-build /usr/share/doc/libstdc++6/copyright /usr/share/doc/libstdc++6/copyright
COPY --from=java-build /out /opt/runtime
COPY --from=go-build /out/peer /opt/runtime/peer
COPY --from=go-build /out/go-guard.txt /out/go-wrapper.txt /out/go-calendar.txt /opt/runtime/proofs/
COPY --from=go-build /out/licenses /opt/runtime/licenses
WORKDIR /lab
COPY tools/fix-session/runtime ./tools/fix-session/runtime
COPY tools/fix-session/preflight.py ./tools/fix-session/preflight.py
COPY tools/fix-session/gate.py tools/fix-session/run_matrix.py tools/fix-session/dependencies.lock.json tools/fix-session/Dockerfile tools/fix-session/preservation_v2.py tools/fix-session/preservation.json tools/fix-session/preservation-v2.json ./tools/fix-session/
COPY tests/fix-session ./tests/fix-session
COPY tests/fix-live/*.py ./tests/fix-live/
COPY test-data/fix44/live/manifest.json ./test-data/fix44/live/
COPY scripts/test-fix-session.py ./scripts/test-fix-session.py
COPY contracts/fix-session-runtime-v1.json ./contracts/fix-session-runtime-v1.json
COPY test-data/fix44/runtime/manifest.json test-data/fix44/runtime/bindings.json ./test-data/fix44/runtime/
COPY verification/vendor/quickfix/FIX44.xml ./dictionary/FIX44.xml
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 TMPDIR=/state
USER 1000:1000
CMD ["python", "-m", "unittest", "discover", "-s", "tests/fix-session", "-p", "test_runtime.py", "-v"]
