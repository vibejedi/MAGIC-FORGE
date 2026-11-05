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

# `forge server`: the dedicated game server
FROM eclipse-temurin:21-jre AS server
# The JVM flags Forge's own launcher passes (module access for XStream, Netty, Swing).
ENV FORGE_JVM_FLAGS="-Dio.netty.tryReflectionSetAccessible=true -Dfile.encoding=UTF-8 --add-opens java.desktop/java.beans=ALL-UNNAMED --add-opens java.desktop/javax.swing.border=ALL-UNNAMED --add-opens java.desktop/javax.swing.event=ALL-UNNAMED --add-opens java.desktop/sun.swing=ALL-UNNAMED --add-opens java.desktop/java.awt.image=ALL-UNNAMED --add-opens java.desktop/java.awt.color=ALL-UNNAMED --add-opens java.desktop/sun.awt.image=ALL-UNNAMED --add-opens java.desktop/javax.swing=ALL-UNNAMED --add-opens java.desktop/java.awt=ALL-UNNAMED --add-opens java.base/java.util=ALL-UNNAMED --add-opens java.base/java.lang=ALL-UNNAMED --add-opens java.base/java.lang.reflect=ALL-UNNAMED --add-opens java.base/java.text=ALL-UNNAMED --add-opens java.desktop/java.awt.font=ALL-UNNAMED --add-opens java.base/jdk.internal.misc=ALL-UNNAMED --add-opens java.base/sun.nio.ch=ALL-UNNAMED --add-opens java.base/java.nio=ALL-UNNAMED --add-opens java.base/java.math=ALL-UNNAMED --add-opens java.base/java.util.concurrent=ALL-UNNAMED --add-opens java.base/java.net=ALL-UNNAMED"
COPY --from=build /out /forge
WORKDIR /forge/forge-gui-desktop
ENV JAVA_OPTS="-Xmx1536m"
# Forge's user folder (preferences, and results waiting to be re-sent) lives in /root/.forge
VOLUME /root/.forge
CMD ["sh", "-c", "exec java $JAVA_OPTS $FORGE_JVM_FLAGS -Djava.awt.headless=true -cp target/classes:../forge-gui/target/classes:../forge-ai/target/classes:../forge-game/target/classes:../forge-core/target/classes:/forge/lib/* forge.view.Main server"]

# Browser play: the Forge desktop app on a virtual display, streamed with noVNC.
FROM eclipse-temurin:21-jre AS stream
ENV FORGE_JVM_FLAGS="-Dio.netty.tryReflectionSetAccessible=true -Dfile.encoding=UTF-8 --add-opens java.desktop/java.beans=ALL-UNNAMED --add-opens java.desktop/javax.swing.border=ALL-UNNAMED --add-opens java.desktop/javax.swing.event=ALL-UNNAMED --add-opens java.desktop/sun.swing=ALL-UNNAMED --add-opens java.desktop/java.awt.image=ALL-UNNAMED --add-opens java.desktop/java.awt.color=ALL-UNNAMED --add-opens java.desktop/sun.awt.image=ALL-UNNAMED --add-opens java.desktop/javax.swing=ALL-UNNAMED --add-opens java.desktop/java.awt=ALL-UNNAMED --add-opens java.base/java.util=ALL-UNNAMED --add-opens java.base/java.lang=ALL-UNNAMED --add-opens java.base/java.lang.reflect=ALL-UNNAMED --add-opens java.base/java.text=ALL-UNNAMED --add-opens java.desktop/java.awt.font=ALL-UNNAMED --add-opens java.base/jdk.internal.misc=ALL-UNNAMED --add-opens java.base/sun.nio.ch=ALL-UNNAMED --add-opens java.base/java.nio=ALL-UNNAMED --add-opens java.base/java.math=ALL-UNNAMED --add-opens java.base/java.util.concurrent=ALL-UNNAMED --add-opens java.base/java.net=ALL-UNNAMED"
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11vnc novnc websockify openbox fonts-dejavu-core \
      libxrender1 libxtst6 libxi6 curl openssl procps python3 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -m -s /bin/bash player
COPY --from=build /out /forge
COPY stream/ /opt/stream/
RUN chmod 755 /opt/stream/launcher.sh && mkdir -p /home/player/.cache/forge && chown -R player:player /home/player
EXPOSE 6080
CMD ["/opt/stream/launcher.sh"]
