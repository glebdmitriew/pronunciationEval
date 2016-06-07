var fs = require('fs');
var path = require('path');
var exec = require('child_process').exec;
var execFile = require('child_process').execFile;

for (var i = 0; i < process.argv.length; i++) {
    var arg = process.argv[i];
    if (arg == '-audio') {
        var audioPath = process.argv[i+1];
    } else if (arg == '-textPath') {
        var textPath = process.argv[i+1];
    } else if (arg == '-sphinx_fe') {
        var featExtrPath = process.argv[i+1];
    } else if (arg == '-sphinx3_align') {
        sphinxAlignPath = process.argv[i+1];
    } else if (arg == '-pocketsphinx') {
        var pSphinxPath = process.argv[i+1];
    } else if (arg == '-pocketsphinx_model') {
        var pSphinxModelPath = process.argv[i+1];
    } else if (arg == '-dict') {
        var dictPath = process.argv[i+1];
    } else if (arg == '-allphone') {
        var allphonePath = process.argv[i+1];
    }
}

if (!audioPath || !textPath || !featExtrPath || !sphinxAlignPath || !pSphinxPath || !pSphinxModelPath || !dictPath || !allphonePath) {
    console.log("please check params");
} else {
    var transcript = fs.readFileSync(textPath, 'utf8');

    var audioPathObject = path.parse(audioPath);

    extractFeatures(audioPath, function () {
        align(audioPath, transcript, function (insentPath, phonesegdir, audioPath, isAligned) {
            if (isAligned) {
                evaluateAlignedPronunciation(insentPath, phonesegdir, audioPath);
            } else {
                evaluateNonAlignedPronunciation(insentPath, audioPath, transcript);
            }
        });
    });
}

function extractFeatures(audioPath, onFinish) {
    var audioPathObject = path.parse(audioPath);

    execFile(featExtrPath, [
        '-i', audioPath,
        '-o', path.format({dir: audioPathObject.dir, name: audioPathObject.name, ext: '.mfc'}),
        '-dither', 'yes',
        '-lowerf', '1',
        '-upperf', '8000',
        '-nfilt', '26',
        '-transform', 'dct',
        '-round_filters', 'no',
        '-remove_dc', 'yes',
        '-wlen', '0.025',
        '-mswav', 'yes'
    ], {}, function(error, stdout, stderr) {
        // command output is in stdout
        console.log("!FE! error= " + error);
        console.log("!FE! stdout= " + stdout);
        console.log("!FE! stderr= " + stderr);

        onFinish && onFinish();
    });
}

function align(audioPath, transcript, onFinish) {
    var audioPathObject = path.parse(audioPath);
    var name = audioPathObject.name;

    var ctlPath = path.format({dir: audioPathObject.dir, name: name, ext: '.ctl'});
    var insentPath = path.format({dir: audioPathObject.dir, name: name, ext: '.insent'});
    var phonesegdir =  audioPathObject.dir + '/' + name + '.phonesegdir';

    fs.writeFileSync(ctlPath, name);
    fs.writeFileSync(insentPath, transcript + " (" + name + ")");

    exec('mkdir ‐p ' + audioPathObject.dir + '/' + name + '{.phonelabdir,.phonesegdir,.statesegdir,.aligndir}', function(error, stdout, stderr) {
        // command output is in stdout

        execFile(sphinxAlignPath, [
            '-hmm', 'wsj_all_cd30.mllt_cd_cont_4000',
            '-dict', dictPath,
            '-fdict', 'phone.filler',
            '-ctl', ctlPath,
            '-cepdir', audioPathObject.dir,
            '-insent', insentPath,
            '-outsent', audioPathObject.dir + '/' + name + '.outsent',
            '-phlabdir', audioPathObject.dir + '/' + name + '.phonelabdir',
            '-phsegdir', phonesegdir,
            '-stsegdir', audioPathObject.dir + '/' + name + '.statesegdir',
            '-wdsegdir', audioPathObject.dir + '/' + name + '.aligndir',
        ], {}, function(error, stdout, stderr) {
            // command output is in stdout
            console.log("!error= " + error);
            console.log("!stdout= " + stdout);
            console.log("!stderr= " + stderr);

            var phonesegdirFiles = fs.readdirSync(phonesegdir);

            var isAligned = phonesegdirFiles && (phonesegdirFiles.length > 0);

            onFinish && onFinish(insentPath, phonesegdir, audioPath, isAligned);
        });
    });
}

function evaluateNonAlignedPronunciation(insentPath, audioPath, transcript) {
    var audioPathObject = path.parse(audioPath);

    console.log("##### " + pSphinxPath);

    execFile(path.join(pSphinxPath, 'bin/pocketsphinx_continuous'), [
        '-infile', audioPath,
        '-hmm', pSphinxModelPath,
        '-allphone', allphonePath,
        '-backtrace', 'yes',
        '-beam', '1e-20',
        '-pbeam', '1e-20',
        '-lw', '2.0'
    ], {}, function(error, stdout, stderr) {
        var outputPhones = stdout.replace(/SIL/g, '').trim();
        var expectedPhones = getPhonesForTranscript(transcript).trim();

        var editDist = getEditDistance(outputPhones, expectedPhones);

        var score = (1 - editDist / Math.max(outputPhones.length, expectedPhones.length)) * 100;

        var output = "Score: " + score + "\n";
        output += "Expected:\t" + expectedPhones + "\n";
        output += "Pronounced:\t" + outputPhones + "\n";

        fs.writeFileSync(path.format({dir: audioPathObject.dir, name: "_" + audioPathObject.name + "_result", ext: '.txt'}), output);
    });
}

function getPhonesForTranscript(transcript) {
    var allPhones = '';
    var dictionary = fs.readFileSync(dictPath, 'utf8');
    var words = transcript.trim().split(/\s+/);
    
    var dictionaryItems = dictionary.split("\n");
    var dictionaryJSON = {};

    for (var i = 0; i < dictionaryItems.length; i++) {
        var dictItem = dictionaryItems[i];
        var dictItemElems = dictItem.split(/\s(.+)?/);
        dictionaryJSON[dictItemElems[0]] = dictItemElems[1];
    }

    for (var i = 0; i < words.length; i++) {
        var word = words[i].toLowerCase();
        if (dictionaryJSON.hasOwnProperty(word)) {
            allPhones += dictionaryJSON[word] + ' ';
        }
    }

    return allPhones;
}

function evaluateAlignedPronunciation(insentPath, phonesegdir, audioPath) {
    var audioPathObject = path.parse(audioPath);
    var cmuPhones = {};
    var allPhones = [];
    var ac_scores = [];
    var words = [];
    var w_score = [];

    var outputString = '';

    var STATS_PATH = 'TIMIT_statistics.txt';
    var CMU_PHONES_PATH = 'CMUphones_list';

    var in_sentence = fs.readFileSync(insentPath, 'utf8');
    var in_data = fs.readFileSync(STATS_PATH, 'utf8');
    var in_phone = fs.readFileSync(CMU_PHONES_PATH, 'utf8');
    var in_phone = fs.readFileSync(CMU_PHONES_PATH, 'utf8');

    console.log("@@!!@@: " + in_phone);

    var cmuPhonesArray = in_phone.split("\n");

    for (var i = 0; i < cmuPhonesArray.length; i++) {
        cmuPhones[cmuPhonesArray[i]] = cmuPhonesArray[i];
    }

    var statsArray = in_data.split("\n");

    for (var i = 0; i < statsArray.length; i++) {
        var statsLine = statsArray[i];
        var ph_data = statsLine.trim().split(/\s+/);
        allPhones.push([ph_data[0], ph_data[1], ph_data[2], ph_data[3], ph_data[4], ph_data[5]]);
    }

    var wc = 0;
    var sentenceArray = in_sentence.split("\n");

    for (var i = 0; i < sentenceArray.length; i++) {
        var sent = sentenceArray[i].trim();
        var wds = sent.split(/\s+/);
        wc = 0;

        while (wc < wds.length) {
            words.push(wds[wc]);
            ++ wc;
        }
    }

    console.log("----: " + words);

    var word_count = wc - 1;

    wc = 0;
    var count = 1;
    var pos = 0;
    var ph_cnt = 0;
    var fn_score = 0;
    var wd_score = 0;
    var rate = '';
    var rt_full = 0;
    var score1 = 0;
    var score2 = 0;
    var indx = 0;

    var phonesegdirFiles = fs.readdirSync(phonesegdir);

    for (var i = 0; i < phonesegdirFiles.length; i++) {
        if (phonesegdirFiles[i].indexOf('.phseg') == -1) {
            continue;
        }
        var phoneList = fs.readFileSync(phonesegdir + '/' + phonesegdirFiles[i]) + '';

        score1 = 0;
        score2 = 0;

        console.log("!!!!!!!!!!!!!!!!!!!!!!!" + phoneList);

        var phoneListLines = phoneList.split("\n");
        for (var j = 0; j < phoneListLines.length; j++) {
            var seg_p1 = phoneListLines[j].trim();

            if (seg_p1 == '') {
                break;
            }

            var s = seg_p1.split(/\s+/);

            if (!isNaN(s[0]) && cmuPhones.hasOwnProperty(s[3])) {
                indx = 0;

                if (s[s.length - 1] == 'i') {
                    pos = 1;
                } else if (s[s.length - 1] == 'b') {
                    pos = 0;
                } else {
                    pos = 2;
                }

                while (true) {
                    if (allPhones[indx][0] == s[3] && parseInt(allPhones[indx][1], 10) == pos) {
                        break;
                    } else {
                        ++indx;
                    }
                }

                var phone_duration = (((parseInt(s[1], 10) - parseInt(s[0], 10)) + 1) * 10) + 15;

                var log_score = Math.log(1 - parseInt(s[2], 10));
                var t_score = Math.abs((log_score - parseFloat(allPhones[indx][2])) / parseFloat(allPhones[indx][3]));
                var sgn_score = (phone_duration - parseFloat(allPhones[indx][4])) / parseFloat(allPhones[indx][5]);

                if (sgn_score < 0) {
                    rate = 'Fast';
                    ++rt_full;
                } else {
                    rate = 'Slow';
                    --rt_full;
                }

                var z_score = Math.abs(sgn_score);

                if (z_score < 1) {
                    rate = 'Normal';
                }

                var st_score1 = 5 - t_score;
                var st_score2 = 5 - z_score;

                if (st_score2 < 0) {
                    st_score2 = 0;
                }

                score1 += st_score1;
                score2 += st_score2;
                ++ph_cnt;

                if (s[s.length - 1] == 'e' || s[s.length - 1] == 's') {
                    wd_score = (score1 + score2) / ph_cnt;
                    fn_score += wd_score;
                    ostr = words[wc] + ' ' + wd_score;
                    outputString += ostr + ' ' + rate + '\n';
                    wc += 1;
                    score1 = 0;
                    score2 = 0;
                    ph_cnt = 0;
                }
            }
        }

    }

    fn_score /= wc;
    ostr = 'Complete_phrase ' + fn_score;
    if (rt_full > 0) {
        rate = 'Fast';
    } else {
        rate = 'Slow';
    }

    if (fn_score >= 7.5) {
        rate = 'Normal';
    }

    outputString += ostr + rate + '\n';

    var outPath = path.format({dir: audioPathObject.dir, name: "_" + audioPathObject.name + "_result", ext: '.txt'});
    fs.writeFileSync(outPath, outputString);
}


function getEditDistance(a, b){
    if(a.length == 0) return b.length;
    if(b.length == 0) return a.length;

    var matrix = [];

    // increment along the first column of each row
    var i;
    for(i = 0; i <= b.length; i++){
        matrix[i] = [i];
    }

    // increment each column in the first row
    var j;
    for(j = 0; j <= a.length; j++){
        matrix[0][j] = j;
    }

    // Fill in the rest of the matrix
    for(i = 1; i <= b.length; i++){
        for(j = 1; j <= a.length; j++){
            if(b.charAt(i-1) == a.charAt(j-1)){
                matrix[i][j] = matrix[i-1][j-1];
            } else {
                matrix[i][j] = Math.min(matrix[i-1][j-1] + 1, // substitution
                    Math.min(matrix[i][j-1] + 1, // insertion
                        matrix[i-1][j] + 1)); // deletion
            }
        }
    }

    return matrix[b.length][a.length];
};