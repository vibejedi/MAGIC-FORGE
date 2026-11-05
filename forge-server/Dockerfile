# Builds Forge at the pinned commit with the dedicated-server patch, and runs `forge server`.
FROM maven:3.9-eclipse-temurin-21 AS build
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
ARG FORGE_REPO=https://github.com/Card-Forge/forge.git
COPY FORGE_COMMIT /patches/FORGE_COMMIT
COPY patches/ /patches/
WORKDIR /src
RUN git init -q forge && cd forge \
 && git remote add origin "$FORGE_REPO" \
 && git fetch -q --depth 1 origin "$(cat /patches/FORGE_COMMIT)" \
 && git checkout -q FETCH_HEAD \
 && git apply /patches/*.patch
WORKDIR /src/forge
RUN mvn -B -q -pl forge-gui-desktop -am -DskipTests -Dcheckstyle.skip \
      compile dependency:build-classpath -Dmdep.outputFile=/tmp/cp.txt -Dmdep.includeScope=runtime
# Lay out compiled modules + card data the way Forge expects when run from source
# (it resolves its data folder as ../forge-gui/ relative to forge-gui-desktop).
RUN mkdir -p /out/lib \
 && tr ':' '\n' < /tmp/cp.txt | grep '\.jar$' | xargs -I{} cp {} /out/lib/ \
 && for m in forge-core forge-game forge-ai forge-gui forge-gui-desktop; do \
      mkdir -p /out/$m/target && cp -r $m/target/classes /out/$m/target/; done \
 && cp -r forge-gui/res /out/forge-gui/res \
 && rm -rf /out/forge-gui/res/adventure /out/forge-gui/res/music /out/forge-gui/res/sound

FROM eclipse-temurin:21-jre
COPY --from=build /out /forge
WORKDIR /forge/forge-gui-desktop
ENV JAVA_OPTS="-Xmx1536m"
# Forge's user folder (preferences, and results waiting to be re-sent) lives in /root/.forge
VOLUME /root/.forge
CMD ["sh", "-c", "exec java $JAVA_OPTS -Djava.awt.headless=true -cp target/classes:../forge-gui/target/classes:../forge-ai/target/classes:../forge-game/target/classes:../forge-core/target/classes:/forge/lib/* forge.view.Main server"]
