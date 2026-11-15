# Runtime image for the Unity (FishNet) dedicated race server.
# The build itself is NOT copied into the image: docker-compose mounts
# ./outfiles/LinuxServer (local, not versioned) at /server, so a new
# Unity build only needs `docker compose restart race-server`.
FROM --platform=linux/amd64 ubuntu:22.04

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libgcc-s1 libstdc++6 zlib1g \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 10001 raceserver

USER raceserver
WORKDIR /server

# 7770 = NetLaunchOptions.DefaultPort in RacingGame.Net.dll
EXPOSE 7770/udp

ENTRYPOINT ["/server/RaceServer.x86_64", "-batchmode", "-nographics", "-logfile", "-"]
CMD ["-server", "-port", "7770"]
