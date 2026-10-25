// Loads the chunked Unity payloads listed in Build/awd.split.json.
// Each list of parts is downloaded into one buffer in order, so UnityLoader
// still receives exactly the same bytes it would have received from one file.
(function () {
  "use strict";

  if (!window.UnityLoader || UnityLoader.__splitFileLoaderInstalled) return;
  UnityLoader.__splitFileLoaderInstalled = true;

  var MANIFEST_NAME = "awd.split.json";
  var CONCURRENCY = 6;
  var RETRIES = 2;

  var originalDownloadJob = UnityLoader.downloadJob;
  var manifestPromise = null;
  var errorShown = false;

  function fail(message) {
    console.error("[SplitFileLoader] " + message);
    if (!errorShown) {
      errorShown = true;
      alert(
        "The game files could not be loaded:\n" +
          message +
          "\n\nMake sure every .part file was uploaded."
      );
    }
  }

  function loadManifest(module) {
    if (!manifestPromise) {
      manifestPromise = new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        xhr.open("GET", module.resolveBuildUrl(MANIFEST_NAME), true);
        xhr.responseType = "text";
        xhr.onload = function () {
          if (xhr.status < 200 || xhr.status >= 300) {
            reject(new Error("Unable to load " + MANIFEST_NAME + " (" + xhr.status + ")"));
            return;
          }
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch (error) {
            reject(error);
          }
        };
        xhr.onerror = function () {
          reject(new Error("Unable to load " + MANIFEST_NAME));
        };
        xhr.send();
      });
    }
    return manifestPromise;
  }

  function basename(url) {
    var clean = url.split("#")[0].split("?")[0];
    var name = clean.substring(clean.lastIndexOf("/") + 1);
    try {
      return decodeURIComponent(name);
    } catch (error) {
      return name;
    }
  }

  function dirname(url) {
    var clean = url.split("#")[0].split("?")[0];
    return clean.substring(0, clean.lastIndexOf("/") + 1);
  }

  // onLoaded receives the total bytes of this part that are known to be
  // available, so a retry never reports the same bytes twice.
  function fetchPart(partUrl, expectedSize, onLoaded, attempt, knownBytes) {
    attempt = attempt || 0;
    knownBytes = knownBytes || 0;

    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      var reported = knownBytes;

      xhr.open("GET", partUrl, true);
      xhr.responseType = "arraybuffer";
      xhr.onprogress = function (event) {
        if (!event.lengthComputable && !event.loaded) return;
        var current = Math.min(event.loaded || 0, expectedSize);
        if (current > reported) {
          reported = current;
          onLoaded(current);
        }
      };
      xhr.onload = function () {
        if (xhr.status < 200 || xhr.status >= 300) {
          retryOrFail(new Error(partUrl + " returned " + xhr.status));
          return;
        }
        var chunk = new Uint8Array(xhr.response);
        if (chunk.byteLength !== expectedSize) {
          retryOrFail(
            new Error(
              partUrl + " is " + chunk.byteLength + " bytes, expected " + expectedSize
            )
          );
          return;
        }
        onLoaded(expectedSize);
        resolve(chunk);
      };
      xhr.onerror = function () {
        retryOrFail(new Error("Network error while loading " + partUrl));
      };
      xhr.ontimeout = function () {
        retryOrFail(new Error("Timed out while loading " + partUrl));
      };

      function retryOrFail(error) {
        xhr.onprogress = null;
        xhr.onload = null;
        xhr.onerror = null;
        xhr.ontimeout = null;

        if (attempt < RETRIES) {
          setTimeout(function () {
            fetchPart(partUrl, expectedSize, onLoaded, attempt + 1, reported).then(
              resolve,
              reject
            );
          }, 250 * (attempt + 1));
        } else {
          reject(error);
        }
      }

      xhr.send();
    });
  }

  function downloadParts(entry, baseUrl, onProgress) {
    var parts = entry.parts || [];
    var totalSize = 0;
    for (var i = 0; i < parts.length; i++) totalSize += parts[i].size;

    if (!parts.length || totalSize !== entry.size) {
      return Promise.reject(new Error("Invalid manifest entry for " + entry.name));
    }

    var buffer = new Uint8Array(totalSize);
    var loaded = 0;
    var nextPart = 0;
    var completed = 0;
    var failed = false;

    function report() {
      onProgress(loaded, totalSize);
    }

    return new Promise(function (resolve, reject) {
      function startNext() {
        if (failed) return;

        while (nextPart < parts.length && nextPart - completed < CONCURRENCY) {
          (function (index) {
            var part = parts[index];
            var offset = 0;
            for (var i = 0; i < index; i++) offset += parts[i].size;
            var credited = 0;

            fetchPart(baseUrl + part.name, part.size, function (partLoaded) {
              if (partLoaded > credited) {
                loaded += partLoaded - credited;
                credited = partLoaded;
                report();
              }
            }).then(
              function (chunk) {
                if (failed) return;
                buffer.set(chunk, offset);
                completed++;
                if (completed === parts.length) {
                  resolve(buffer);
                } else {
                  startNext();
                }
              },
              function (error) {
                if (failed) return;
                failed = true;
                reject(error);
              }
            );
          })(nextPart++);
        }
      }

      report();
      startNext();
    });
  }

  UnityLoader.downloadJob = function (module, job) {
    var params = job.parameters;
    var url = params.url;

    // Only UnityWeb payloads can be split; other files keep the stock loader.
    if (!/\.unityweb(?:$|[?#])/.test(url)) {
      return originalDownloadJob(module, job);
    }

    loadManifest(module).then(
      function (manifest) {
        var entry = manifest.files && manifest.files[basename(url)];
        if (!entry) {
          originalDownloadJob(module, job);
          return;
        }

        var lastReported = -1;
        function onProgress(loaded, total) {
          if (loaded === lastReported) return;
          lastReported = loaded;
          if (params.onprogress) {
            params.onprogress({
              type: "progress",
              lengthComputable: true,
              total: total,
              loaded: loaded,
            });
          }
        }

        downloadParts(entry, dirname(url), onProgress).then(
          function (data) {
            if (params.onload) {
              params.onload({
                type: "load",
                lengthComputable: true,
                total: data.length,
                loaded: data.length,
              });
            }
            UnityLoader.Compression.decompress(data, function (decompressed) {
              job.complete(decompressed);
            });
          },
          function (error) {
            fail(error.message);
          }
        );
      },
      function (error) {
        fail(error.message);
        originalDownloadJob(module, job);
      }
    );
  };
})();
