// check if the WASM module is loaded
if (typeof Module != "object") {
    throw new Error(
        "WASM module is " +
            typeof Module +
            " (expected object), make sure you added a <script> tag for libxm.js"
    );
}

const getAudioContext = window["AudioContext"] || window["webkitAudioContext"];

// if this is a function, it will be called when emscripten's runtime is initialized
let libxm = { onload: null };
let isRuntimeInitialized = false;
// prettier-ignore
libxm.notes = ['A-', 'A#', 'B-', 'C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#'];

// get note string for frequency
libxm.getNoteForFreq = function (frequency) {
    return (
        libxm.notes[
            Math.round((12.0 * Math.log(frequency / 440.0)) / Math.log(2)) % 12
        ] + Math.floor(Math.log(frequency) / Math.log(2) - 10)
    );
};

Module["onRuntimeInitialized"] = function () {
    isRuntimeInitialized = true;
    if (libxm.onload instanceof Function) libxm.onload();
};

/** Main constructor.
 * @param sampleRate - how much samples to generate and play per second
 * @param onfillbuffer - will be called each time when filling new audio buffer
 * @param onxmdataupdate - will be called each time when XMModule.xmdata updates
 */
function XMModule(
    sampleRate = 48000,
    onfillbuffer = null,
    onxmdataupdate = null
) {
    if (!isRuntimeInitialized) throw "Runtime is not initialized!";
    this.onfillbuffer = onfillbuffer;
    this.onxmdataupdate = onxmdataupdate;

    this.AUDIO_BUFFER_LENGTH = 4096;
    this.XM_BUFFER_LENGTH = 256;
    this.xmdataLengthLimit = 256; // maximum length of this.xmdata
    this.sampleRate = sampleRate;
    if (this.sampleRate < 1) this.sampleRate = 1;

    // create audio context and two buffers
    this.audioContext = new getAudioContext();
    this.buffers = [
        this.audioContext.createBuffer(
            2,
            this.AUDIO_BUFFER_LENGTH,
            this.sampleRate
        ),
        this.audioContext.createBuffer(
            2,
            this.AUDIO_BUFFER_LENGTH,
            this.sampleRate
        ),
    ];

    this.LATENCY_COMP =
        this.sampleRate *
            (this.audioContext.outputLatency |
                this.audioContext.baseLatency |
                0.25) -
        this.sampleRate / 60;

    this.playing = false;
    this.needsResync = true;
    this.audioSyncPoint = 0;
    this.xmSyncPoint = 0;
    this.amplification = 1.0;
    this.clip = false;

    this.libxmActions = [];
    this.runXmContextAction = function (action) {
        if (this.libxmActions.length > 0) {
            this.libxmActions.push(action);
            return;
        }

        this.libxmActions.push(action);

        while (this.libxmActions.length > 0) {
            this.libxmActions.shift()();
        }
    };

    this.cFloatArray = Module._malloc(2 * this.XM_BUFFER_LENGTH * 4);
    this.moduleContextPtr = Module._malloc(4);
    this.moduleContext = null;
    this.cSamplesPtr = Module._malloc(8);
    this.xmdata = [];
    this.instrumentsNum = null;
    this.channelsNum = null;
    this.isModuleLoaded = false;

    // only for internal use, use XMModule.load if you want to load modules
    this._loadFromData = function (data, callback) {
        this.runXmContextAction(
            function () {
                if (this.moduleContext !== null) {
                    Module._xm_free_context(this.moduleContext);
                    this.isModuleLoaded = false;
                    this.moduleContext = null;
                }

                // make it an int8array if it isn't one
                if (!(data instanceof Int8Array))
                    var view = new Int8Array(data);

                var moduleStringBuffer = Module._malloc(view.length);
                Module.writeArrayToMemory(view, moduleStringBuffer);
                var ret = Module._xm_create_context(
                    this.moduleContextPtr,
                    moduleStringBuffer,
                    this.sampleRate
                );
                Module._free(moduleStringBuffer);

                if (ret !== 0) {
                    this.moduleContext = null;
                } else {
                    this.moduleContext = getValue(this.moduleContextPtr, "*");
                }
            }.bind(this)
        );

        // error
        if (this.moduleContext === null) {
            if (callback instanceof Function) {
                callback("Failed to create module context");
            }
            return;
        }

        // success
        this.isModuleLoaded = true;
        this.xmdata = [];
        
        if (typeof onxmdataupdate == "function") onxmdataupdate();
        
        this.instrumentsNum = Module._xm_get_number_of_instruments(
            this.moduleContext
        );

        this.channelsNum = Module._xm_get_number_of_channels(
            this.moduleContext
        );

        this.pause();
        if (callback instanceof Function) {
            callback(false);
        }
    };

    /** Loads an XM module.
     * @param {(File|string|Int8Array)} input - loads the module from file, URL or Int8Array.
     * @param {Function} callback<err> - callback function after module load.
     * Callback has 1 parameter (error) - false if loaded successfully, string if not.
     */
    this.load = function (input, callback) {
        if (input instanceof Int8Array) {
            this._loadFromData(input, callback);
        } else if (input instanceof File) {
            // input is a file, read it
            var reader = new FileReader();
            reader.onload = function () {
                this._loadFromData(reader.result, callback);
            }.bind(this);
            reader.readAsArrayBuffer(input);
        } else if (typeof input === "string" || input instanceof String) {
            // load from URL
            var xhr = new XMLHttpRequest();
            xhr.open("GET", input, true);
            xhr.responseType = "arraybuffer";
            xhr.onload = function () {
                if (xhr.status === 200) {
                    this._loadFromData(xhr.response, callback);
                } else {
                    if (callback instanceof Function) {
                        callback(
                            "Recieved status code " +
                                xhr.status +
                                ", expected 200"
                        );
                    }
                }
            }.bind(this);
            xhr.onerror = function () {
                if (callback instanceof Function) {
                    callback("XHR request error");
                }
            };
            xhr.onabort = function () {
                if (callback instanceof Function) {
                    callback("XHR request aborted");
                }
            };
            xhr.send();
        } else {
            if (callback instanceof Function) {
                callback(
                    'Unknown input type "' +
                        typeof input +
                        '", expected File, String or Int8Array'
                );
            }
        }
    }.bind(this);

    this.fillBuffer = function (buffer) {
        var l = buffer.getChannelData(0);
        var r = buffer.getChannelData(1);

        for (
            var off = 0;
            off < this.AUDIO_BUFFER_LENGTH;
            off += this.XM_BUFFER_LENGTH
        ) {
            Module._xm_generate_samples(
                this.moduleContext,
                this.cFloatArray,
                this.XM_BUFFER_LENGTH
            );
            if (typeof this.onfillbuffer == "function") this.onfillbuffer();

            for (var j = 0; j < this.XM_BUFFER_LENGTH; ++j) {
                l[off + j] =
                    Module.getValue(this.cFloatArray + 8 * j, "float") *
                    this.amplification;
                r[off + j] =
                    Module.getValue(this.cFloatArray + 8 * j + 4, "float") *
                    this.amplification;
                if (
                    !this.clip &&
                    (l[j] < -1.0 || l[j] > 1.0 || r[j] < -1.0 || r[j] > 1.0)
                ) {
                    clip = true;
                }
            }

            var xmd = {};

            Module._xm_get_position(
                this.moduleContext,
                null,
                null,
                null,
                this.cSamplesPtr
            );
            xmd.sampleCount = Module.getValue(this.cSamplesPtr, "i64");
            xmd.instruments = [];

            for (var j = 1; j <= this.instrumentsNum; ++j) {
                xmd.instruments.push({
                    latestTrigger: Module._xm_get_latest_trigger_of_instrument(
                        this.moduleContext,
                        j
                    ),
                });
            }

            xmd.channels = [];
            for (var j = 1; j <= this.channelsNum; ++j) {
                xmd.channels.push({
                    active: this.isChannelActive(j),
                    latestTrigger: this.getLatestTriggerOfChannel(j),
                    volume: this.getVolumeOfChannel(j),
                    panning: this.getPanningOfChannel(j),
                    frequency: this.getFrequencyOfChannel(j),
                    instrument: this.getInstrumentOfChannel,
                });
            }

            this.xmdata.push(xmd);
            while (this.xmdata.length > this.xmdataLengthLimit)
                this.xmdata.shift();
            if (typeof this.onxmdataupdate == "function") this.onxmdataupdate();
        }
    }.bind(this);

    this.setupSources = function () {
        var makeSourceGenerator = function (index, start) {
            return function () {
                var s = this.audioContext.createBufferSource();
                s.onended = makeSourceGenerator(
                    index,
                    start + 2 * this.AUDIO_BUFFER_LENGTH
                );
                s.buffer = this.buffers[index];
                s.connect(this.audioContext.destination);

                if (this.moduleContext !== null) {
                    this.runXmContextAction(
                        function () {
                            if (this.needsResync) {
                                this.audioSyncPoint = start;
                                Module._xm_get_position(
                                    this.moduleContext,
                                    null,
                                    null,
                                    null,
                                    this.cSamplesPtr
                                );
                                this.xmSyncPoint = Module.getValue(
                                    this.cSamplesPtr,
                                    "i64"
                                );
                                this.needsResync = false;
                            }

                            var target =
                                this.sampleRate *
                                    this.audioContext.currentTime -
                                this.audioSyncPoint -
                                this.LATENCY_COMP;
                            while (
                                this.xmdata.length >= 2 &&
                                this.xmdata[0].sampleCount - this.xmSyncPoint <
                                    target &&
                                this.xmdata[1].sampleCount - this.xmSyncPoint <
                                    target
                            ) {
                                this.xmdata.shift();
                            }
                            if (typeof this.onxmdataupdate == "function")
                                this.onxmdataupdate();

                            this.fillBuffer(s.buffer);
                        }.bind(this)
                    );
                } else {
                    var l = s.buffer.getChannelData(0);
                    var r = s.buffer.getChannelData(1);
                    for (var i = 0; i < this.AUDIO_BUFFER_LENGTH; ++i) {
                        l[i] = r[i] = 0.0;
                    }
                }

                s.start(start / this.sampleRate);
            }.bind(this);
        }.bind(this);

        var t =
            this.sampleRate * this.audioContext.currentTime + this.sampleRate;
        this.runXmContextAction(function () {
            Module._xm_get_position(
                this.moduleContext,
                null,
                null,
                null,
                this.cSamplesPtr
            );
            this.xmSyncPoint = Module.getValue(this.cSamplesPtr, "i64");
        });

        makeSourceGenerator(0, t)();
        makeSourceGenerator(1, t + this.AUDIO_BUFFER_LENGTH)();
    };

    this.pause = function () {
        this.audioContext.suspend();
        this.playing = false;
    };

    this.resume = function () {
        this.audioContext.resume();
        this.playing = true;
    };

    /** Returns the last xmdata of the channel.
     * @note channel numbers start with 1 and end with XMModule.channelsNum
     * @param channel - channel index
     * If the channel does not exist, returns null.
     */
    this.getLastChannelData = function (channel) {
        if (
            this.xmdata.length > 0 &&
            channel >= 0 &&
            channel < this.channelsNum
        ) {
            return this.xmdata[0].channels[channel];
        } else return null;
    };

    /** Returns the last note (not the current) played in channel as a string.
     * @note use XMModule.getPlayingNoteInChannel if you want to get the current playing note
     * @note if no note was playing/channel does not exist, will return "---"
     * @note channel numbers start with 1 and end with XMModule.channelsNum
     * @param channel - channel number
     */
    this.getLastNoteInChannel = function (channel) {
        if (
            this.xmdata.length > 0 &&
            channel >= 0 &&
            channel < this.channelsNum
        ) {
            var channelData = this.getLastChannelData(channel);
            if (channelData) {
                var note = libxm.getNoteForFreq(channelData.frequency);
                if (note + "" == "NaN") note = "---";
                return note;
            } else return "---";
        } else {
            return "---";
        }
    }.bind(this);

    /** Sets the volume of the song (0..100)
     * @note the actual volume will update when the next buffer is filled
     * @param volume - new song volume (amplification)
     */
    this.setVolume = function (volume) {
        var clampedVolume = Math.max(0, Math.min(volume, 100));
        this.amplification = clampedVolume / 100;
    }.bind(this);

    /** Changes the current playback position.
     * @param pot - pattern order index
     * @param row - row of the pattern
     * @param tick - tick of the row to jump to
     * Warning: this can be buggy, don't expect miracles
     */
    this.seek = function (pot, row, tick) {
        Module._xm_seek(this.moduleContext, pot, row, tick);
    }.bind(this);

    // Returns the module name.
    this.getModuleName = function () {
        return Module._xm_get_module_name(this.moduleContext);
    }.bind(this);

    // Returns the tracker name.
    this.getTrackerName = function () {
        return Module._xm_get_tracker_name(this.moduleContext);
    }.bind(this);

    /** Sets the maximum amount of times the module can loop.
     * @param loopCount - amount of times the module can loop.
     * Use 0 if you want the module to loop infinitely.
     */
    this.setMaxLoopCount = function (loopCount) {
        Module._xm_set_max_loop_count(this.moduleContext, loopCount);
    }.bind(this);

    /** Returns the loop count of the currently playing module.
     * This will return 0 if the module is playing for the first time,
     * will return 1 when the module is playing for the second time, etc.
     */
    this.getLoopCount = function () {
        return Module._xm_get_loop_count(this.moduleContext);
    }.bind(this);

    /** Mutes or unmutes a channel
     * @note channel numbers start with 1 and end with XMModule.channelsNum
     * @param channelNum - channel number
     * @param doMute - true if you want to mute the channel, false if unmute
     * @return Whether the channel was muted.
     */
    this.muteChannel = function (channelNum, doMute) {
        return Module._xm_mute_channel(this.moduleContext, channelNum, doMute);
    }.bind(this);

    /** Mutes or unmutes an instrument
     * @note instrument numbers start with 1 and end with XMModule.instrumentsNum
     * @param instrumentNum - instrument number
     * @param doMute - true if you want to mute the instrument, false if unmute
     * @return Whether the instrument was muted.
     */
    this.muteChannel = function (instrumentNum, doMute) {
        return Module._xm_mute_instrument(
            this.moduleContext,
            instrumentNum,
            doMute
        );
    }.bind(this);

    // returns the module length in patterns
    this.getModuleLength = function () {
        return Module._xm_get_module_length(this.moduleContext);
    }.bind(this);

    // if you want to access the amount of instruments/channels,
    // just use XMModule.channelsNum and XMModule.instrumentsNum

    // returns the number of patterns
    this.getNumberOfPatterns = function () {
        return Module._xm_get_number_of_patterns(this.moduleContext);
    }.bind(this);

    /** Get the number of rows of a pattern.
     * @note Pattern numbers go from 0 to
     * XMModule.getNumberOfPatterns(...)-1.
     * @param patternNum - pattern number, read note
     */
    this.getNumberOfRows = function (patternNum) {
        return Module._xm_get_number_of_rows(this.moduleContext, patternNum);
    }.bind(this);

    /** Get the number of samples of an instrument.
     *
     * @note Instrument numbers go from 1 to
     * XMModule.instrumentsNum
     * @param instrumentNum - instrument number, read note
     */
    this.getInstrumentSamplesAmount = function (instrumentNum) {
        return Module._xm_get_number_of_samples(
            this.moduleContext,
            instrumentNum
        );
    }.bind(this);

    /** Get the latest time (in number of generated samples) when a
     * particular instrument was triggered in any channel.
     *
     * @note Instrument numbers go from 1 to
     * XMModule.instrumentsNum
     */
    this.getLatestTriggerOfInstrument = function (channelNum) {
        return Module._xm_get_latest_trigger_of_instrument(
            this.moduleContext,
            instrumentNum
        );
    }.bind(this);

    /** Get the latest time (in number of generated samples) when a
     * particular sample was triggered in any channel.
     *
     * @note Instrument numbers go from 1 to
     * XMModule.instrumentsNum
     *
     * @note Sample numbers go from 0 to
     * XMModule.getInstrumentSamplesAmount(...,instrumentNum)-1.
     */
    this.xm_get_latest_trigger_of_sample = function (instrumentNum, sampleNum) {
        return Module._xm_get_latest_trigger_of_sample(
            this.moduleContext,
            instrumentNum,
            sampleNum
        );
    }.bind(this);

    /** Get the latest time (in number of generated samples) when any
     * instrument was triggered in a given channel.
     *
     * @note Channel numbers go from 1 to XMModule.channelsNum
     */
    this.getLatestTriggerOfChannel = function (channelNum) {
        return Module._xm_get_latest_trigger_of_channel(
            this.moduleContext,
            channelNum
        );
    }.bind(this);

    /** Checks whether a channel is active (ie: is playing something).
     *
     * @note Channel numbers go from 1 to XMModule.channelsNum
     */
    this.isChannelActive = function (channelNum) {
        return Module._xm_is_channel_active(this.moduleContext, channelNum);
    }.bind(this);

    /** Get the instrument number currently playing in a channel.
     *
     * @returns instrument number, or 0 if channel is not active.
     *
     * @note Channel numbers go from 1 to XMModule.channelsNum
     *
     * @note Instrument numbers go from 1 to XMModule.channelsNum
     */
    this.getInstrumentOfChannel = function (channelNum) {
        return Module._xm_get_instrument_of_channel(
            this.moduleContext,
            channelNum
        );
    }.bind(this);

    /** Get the frequency of the sample currently playing in a channel.
     *
     * @returns a frequency in Hz. If the channel is not active, return
     * value is undefined.
     *
     * @note Channel numbers go from 1 to XMModule.channelsNum
     */
    this.getFrequencyOfChannel = function (channelNum) {
        return Module._xm_get_frequency_of_channel(
            this.moduleContext,
            channelNum
        );
    }.bind(this);

    /** Get the volume of the sample currently playing in a channel. This
     * takes into account envelopes, etc.
     *
     * @returns a volume between 0 or 1. If the channel is not active,
     * return value is undefined.
     *
     * @note Channel numbers go from 1 to XMModule.channelsNum.
     */
    this.getVolumeOfChannel = function (channelNum) {
        return Module._xm_get_volume_of_channel(this.moduleContext, channelNum);
    }.bind(this);

    /** Get the panning of the sample currently playing in a channel. This
     * takes into account envelopes, etc.
     *
     * @returns a panning between 0 (L) and 1 (R). If the channel is not
     * active, return value is undefined.
     *
     * @note Channel numbers go from 1 to xm_get_number_of_channels(...).
     */
    this.getPanningOfChannel = function (channelNum) {
        return Module._xm_get_panning_of_channel(
            this.moduleContext,
            channelNum
        );
    }.bind(this);

    /** Returns the playing note in channel as a string.
     * @note if no note is playing/channel does not exist, will return "---"
     * @note channel numbers start with 1 and end with XMModule.channelsNum
     * @param channel - channel number
     */
    this.getPlayingNoteInChannel = function (channel) {
        if (
            this.xmdata.length > 0 &&
            channel >= 0 &&
            channel < this.channelsNum
        ) {
            var channelData = this.getLastChannelData(channel);
            if (channelData && channelData.active) {
                var note = libxm.getNoteForFreq(channelData.frequency);
                if (note + "" == "NaN") note = "---";
                return note;
            } else return "---";
        } else {
            return "---";
        }
    }.bind(this);

    this.setupSources();
    this.pause();
    return this;
}
