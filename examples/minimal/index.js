let xmModule;
let channelsText = document.getElementById("channels-text");

libxm.onload = function () {
    // sample rate, onfillbuffer, onxmdataupdate
    xmModule = new XMModule(48000, null, updateChannelsText);

    var playButton = document.getElementById("play-button");
    playButton.style.display = "none"

    playButton.addEventListener("click", function () {
        if (!xmModule.isModuleLoaded) return;

        if (xmModule.playing) {
            xmModule.pause();
            playButton.textContent = "Play";
        } else {
            xmModule.resume();
            playButton.textContent = "Pause";
        }
    });

    // reset button
    document
        .getElementById("reset-button")
        .addEventListener("click", function () {
            xmModule.seek(0, 0, 0);
        });

    // file input
    var inputElement = document.getElementById("input-file");
    inputElement.onchange = function (event) {
        xmModule.load(event.target.files[0], function (err) {
            // if successful, "err" will be false and this condition won't run
            if (err) {
                console.error(err);
                return;
            }
            playButton.textContent = "Play";
            playButton.style.display = "block";
        });
    };
    /* if you want to load a module from a URL, just pass
    the URL string to XMModule.load. same goes with an Int8Array. */

    // volume slider (0 - minimum volume, 100 - maximum volume)
    var volumeSlider = document.getElementById("volume-slider");
    volumeSlider.oninput = function () {
        xmModule.setVolume(this.value);
    };

    // drag & drop
    document.addEventListener("dragover", function (e) {
        e.stopPropagation();
        e.preventDefault();
    });

    // file dropped
    document.addEventListener("drop", function (e) {
        e.stopPropagation();
        e.preventDefault();
        var files = e.dataTransfer.files; // Array of all files

        xmModule.load(files[0], function (err) {
            if (err) {
                console.error(err);
                return;
            }
            playButton.textContent = "Play";
            playButton.style.display = "block";
            // hide file input
            inputElement.style.display = "none";
        });
    });
};

let previousRow = "";
function updateChannelsText() {
    var rowNotes = [];
    for (var channelNum = 0; channelNum < xmModule.channelsNum; channelNum++) {
        rowNotes.push(xmModule.getPlayingNoteInChannel(channelNum));
    }

    var rowText = rowNotes.join(" | ");

    // don't update the DOM if it's the same
    if (previousRow != rowText) {
        channelsText.textContent = rowText;
        previousRow = rowText;
    }
}
