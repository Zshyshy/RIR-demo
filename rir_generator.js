/**
 * RIR Generator - 实时房间脉冲响应生成器
 * 使用Schroeder参数化模型 + HRTF
 */

class RIRGenerator {
    constructor(options = {}) {
        this.fs = options.fs || 16000;  // 采样率
        this.roomSize = options.roomSize || [5, 4, 3];  // 房间尺寸 [x, y, z] 米
        this.absorption = options.absorption || 0.5;  // 吸声系数 (0-1)
        this.T60 = options.T60 || 0.5;  // 混响时间（秒）
        this.speedOfSound = 343;  // 声速 m/s

        // 预先计算衰减参数
        this._initReverbParams();
    }

    /**
     * 初始化混响参数
     */
    _initReverbParams() {
        // Schroeder模型参数
        // 后期混响衰减曲线
        this.decayFactor = Math.pow(10, -6.9 / this.T60);  // 衰减因子

        // 计算反射系数
        // 使用Sabin公式近似
        const S = 2 * (this.roomSize[0] * this.roomSize[1] +
                      this.roomSize[1] * this.roomSize[2] +
                      this.roomSize[2] * this.roomSize[0]);  // 总表面积
        const V = this.roomSize[0] * this.roomSize[1] * this.roomSize[2];  // 体积
        const alpha = 24 * V * Math.log(10) / (this.speedOfSound * S * this.T60);
        this.beta = Math.min(1, Math.max(0, alpha * this.absorption));
    }

    /**
     * 设置房间参数
     */
    setRoom(roomSize, absorption, T60) {
        this.roomSize = roomSize;
        this.absorption = absorption;
        this.T60 = T60;
        this._initReverbParams();
    }

    /**
     * 计算两点间的距离
     */
    _distance(p1, p2) {
        const dx = p2[0] - p1[0];
        const dy = p2[1] - p1[1];
        const dz = p2[2] - p1[2];
        return Math.sqrt(dx*dx + dy*dy + dz*dz);
    }

    /**
     * 计算向量点积
     */
    _dotProduct(v1, v2) {
        return v1[0]*v2[0] + v1[1]*v2[1] + v1[2]*v2[2];
    }

    /**
     * 向量归一化
     */
    _normalize(v) {
        const len = Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]);
        if (len === 0) return [0, 0, 0];
        return [v[0]/len, v[1]/len, v[2]/len];
    }

    /**
     * 计算声源到麦克风的直达路径参数
     */
    _computeDirectPath(srcPos, micPos, micDir) {
        const distance = this._distance(srcPos, micPos);

        // 直达声延迟（样本数）
        const delaySamples = Math.round((distance / this.speedOfSound) * this.fs);

        // 直达声衰减（距离衰减 + 麦克风指向性）
        // 调整衰减系数，确保音量足够
        let attenuation = 2.0 / (distance + 0.5);  // 减小距离衰减

        // 麦克风指向性（心形）
        const srcDir = this._normalize([
            srcPos[0] - micPos[0],
            srcPos[1] - micPos[1],
            srcPos[2] - micPos[2]
        ]);
        const micDirNorm = this._normalize(micDir);
        const cosAngle = Math.max(0, this._dotProduct(srcDir, micDirNorm));
        const patternFactor = 0.5 + 0.5 * cosAngle;  // 心形pattern

        attenuation *= patternFactor;

        return { delaySamples, attenuation, distance };
    }

    /**
     * 生成简化的早期反射（使用有限镜像源）
     */
    _generateEarlyReflections(srcPos, micPos, micDir, duration) {
        const nSamples = Math.round(duration * this.fs);
        const ir = new Float32Array(nSamples);

        // 简化的镜像源位置（只计算一面墙）
        // 实际应该计算6面墙的镜像，这里简化为直接反射
        const reflectionDelay = (this.roomSize[0] - srcPos[0] + micPos[0]) / this.speedOfSound;

        if (reflectionDelay > 0 && reflectionDelay < duration) {
            const reflIdx = Math.round(reflectionDelay * this.fs);
            // 反射衰减
            const reflAtten = this.beta * 0.5;
            if (reflIdx < nSamples) {
                ir[reflIdx] = reflAtten;
            }
        }

        return ir;
    }

    /**
     * 生成后期混响（使用指数衰减噪声）
     */
    _generateLateReverb(duration) {
        const nSamples = Math.round(duration * this.fs);
        const ir = new Float32Array(nSamples);

        // 生成粉红噪声基底的后期混响
        let prevSample = 0;
        for (let i = 0; i < nSamples; i++) {
            // 白噪声
            let noise = Math.random() * 2 - 1;

            // 指数衰减
            const decay = Math.pow(this.decayFactor, i / this.fs);
            const t = i / this.fs;

            // Schroeder后滤波
            const schroeder = 0.797 * noise + 0.1 * prevSample;
            prevSample = noise;

            // 应用衰减
            ir[i] = schroeder * decay * this.beta * 0.3;
        }

        return ir;
    }

    // 预先生成的噪声基底（用于后期混响）
    _noiseBuffer = null;

    /**
     * 生成单个耳朵的RIR - 去掉随机噪声
     */
    _generateSingleEarRIR(srcPos, micPos, earDir, hrtfGain) {
        const duration = this.T60 * 1.5;
        const nSamples = Math.round(duration * this.fs);
        const ir = new Float32Array(nSamples);

        // 计算距离
        const dist = this._distance(srcPos, micPos);

        // 计算声源到耳朵的方向
        const toSrc = [
            srcPos[0] - micPos[0],
            srcPos[1] - micPos[1],
            srcPos[2] - micPos[2]
        ];
        const toSrcNorm = this._normalize(toSrc);

        // 耳朵朝向的心形指向性
        const earDirNorm = this._normalize(earDir);
        const dot = Math.max(0, this._dotProduct(toSrcNorm, earDirNorm));
        const pattern = 0.5 + 0.5 * dot;

        // 直达声：距离衰减 + 指向性 + HRTF
        const delaySamples = Math.round((dist / this.speedOfSound) * this.fs);
        // 使用反比平方律
        const distanceGain = 4.0 / (dist * dist + 0.5);
        // 不限制最大增益，让ILD效果真正生效
        let gain = hrtfGain * pattern * distanceGain;

        ir[Math.min(delaySamples, nSamples-1)] = gain;

        // 早期反射（简单的）
        const reflections = [0.008, 0.015, 0.025];
        for (const t of reflections) {
            const idx = Math.round(t * this.fs);
            if (idx < nSamples) {
                ir[idx] += gain * 0.15;
            }
        }

        // 后期混响 - 纯指数衰减，需要加上距离衰减
        const lateStart = Math.round(0.04 * this.fs);
        const decayRate = -6.9 / this.T60;

        // 混响也要有距离衰减，但比直达声衰减得慢（声波在房间内反射，能量会分散）
        const reverbDistanceGain = 0.3 / (dist * dist + 0.5);

        for (let i = 0; i < nSamples - lateStart; i++) {
            const t = i / this.fs;
            // 纯指数衰减
            const reverb = Math.exp(decayRate * t) * 0.01;
            ir[lateStart + i] = reverb * this.beta * hrtfGain * reverbDistanceGain;
        }

        return ir;
    }

    /**
     * 生成双耳RIR - 考虑耳朵朝向
     */
    generateBinauralRIR(srcPos, micPos, micDir, earDistance = 0.17) {
        // 头部朝向归一化
        const dirLen = Math.sqrt(micDir[0]*micDir[0] + micDir[2]*micDir[2]);
        const headDir = dirLen > 0 ? [micDir[0]/dirLen, 0, micDir[2]/dirLen] : [0, 0, 1];

        // 双耳位置
        const leftPos = [
            micPos[0] - earDistance * 0.5 * headDir[0],
            micPos[1],
            micPos[2] - earDistance * 0.5 * headDir[2]
        ];
        const rightPos = [
            micPos[0] + earDistance * 0.5 * headDir[0],
            micPos[1],
            micPos[2] + earDistance * 0.5 * headDir[2]
        ];

        // 双耳朝向 - 关键！
        // 左耳朝向：头部朝向 + 稍微向左转
        // 右耳朝向：头部朝向 + 稍微向右转
        // 实际上人耳是朝向前方的，所以朝向与头部相同
        const leftEarDir = headDir;
        const rightEarDir = headDir;

        // 计算声源相对于头部朝向的方向
        const dx = srcPos[0] - micPos[0];
        const dz = srcPos[2] - micPos[2];
        const srcAngle = Math.atan2(dx, dz);
        const faceAngle = dirLen > 0 ? Math.atan2(micDir[0], micDir[2]) : 0;
        // srcAngle - faceAngle
        let relAngle = (srcAngle - faceAngle) * 180 / Math.PI;

        while (relAngle > 180) relAngle -= 360;
        while (relAngle < -180) relAngle += 360;

        // 简化的ILD
        // 使用绝对值计算，让0-180度平滑过渡
        // 0度：左右平衡
        // 90度：ILD最大
        // 180度：左右平衡（背对声源时声音从前方传来）
        let leftGain = 1.0;
        let rightGain = 1.0;

        const absAngle = Math.abs(relAngle);
        // 90度时ILD最大，之后逐渐减小
        const maxILDAngle = 90;
        const factor = Math.min(1, absAngle / maxILDAngle);

        // 当角度超过90度时，逐渐减少ILD效果
        let ildStrength = factor;
        if (absAngle > 90) {
            ildStrength = factor * (1 - (absAngle - 90) / 90);  // 90-180度逐渐减小到0
        }

        if (relAngle > 0) {
            // 声源在左边 - 左耳大声，右耳衰减
            // 科学ILD：90度约4-6dB (1.5-2倍振幅比)
            leftGain = 1.0 + ildStrength * 0.4;
            rightGain = 1.0 / (1.0 + ildStrength * 0.4);
        } else if (relAngle < 0) {
            // 声源在右边 - 右耳大声，左耳衰减
            rightGain = 1.0 + ildStrength * 0.4;
            leftGain = 1.0 / (1.0 + ildStrength * 0.4);
        }

        // 不限制最大增益，让差异更大
        // 混响会自动归一化，所以不用担心削波

        console.log('relAngle:', relAngle.toFixed(1), 'leftGain:', leftGain.toFixed(2), 'rightGain:', rightGain.toFixed(2));

        const leftIR = this._generateSingleEarRIR(srcPos, leftPos, leftEarDir, leftGain);
        const rightIR = this._generateSingleEarRIR(srcPos, rightPos, rightEarDir, rightGain);

        return {
            left: leftIR,
            right: rightIR,
            sampleRate: this.fs,
            angle: relAngle,
            leftGain: leftGain,
            rightGain: rightGain
        };
    }

    /**
     * HRTF处理 - 使用简化的ITD/ILD模型
     * @param {Float32Array} input - 输入音频
     * @param {Object} rir - RIR结果
     * @param {Array} srcPos - 声源位置
     * @param {Array} micPos - 麦克风位置
     * @param {Array} micDir - 麦克风朝向
     * @returns {Object} { left: Float32Array, right: Float32Array }
     */
    applyHRTF(input, rir, srcPos, micPos, micDir) {
        // 计算声源相对于麦克风的方位
        const dx = srcPos[0] - micPos[0];
        const dy = srcPos[1] - micPos[1];
        const dz = srcPos[2] - micPos[2];

        const micDirNorm = this._normalize(micDir);

        // 水平角度
        const horizontalAngle = Math.atan2(
            dx * micDirNorm[2] - dz * micDirNorm[0],
            dx * micDirNorm[0] + dz * micDirNorm[2]
        );

        // ITD (Interaural Time Difference) - 头影效应时间差
        const earDistance = 0.17;
        const itd = (earDistance / 2) * Math.sin(horizontalAngle) / this.speedOfSound;
        const itdSamples = Math.round(itd * this.fs);

        // ILD (Interaural Level Difference) - 头影效应声级差
        // 低频绕射能力强，ILD主要影响高频
        const frequency = 1000;  // 参考频率
        const wavelength = this.speedOfSound / frequency;
        const headRadius = earDistance / 2;
        const ild = 6 + 20 * Math.log10(wavelength / (2 * Math.PI * headRadius));
        const ildLinear = Math.pow(10, ild / 20);

        // 分离RIR的直达声和混响部分
        const directLength = Math.round(0.01 * this.fs);  // 10ms直达声窗口

        // 创建输出数组
        const outputLeft = new Float32Array(input.length);
        const outputRight = new Float32Array(input.length);

        // 对直达声应用HRTF
        for (let i = 0; i < input.length; i++) {
            const leftIdx = i + itdSamples;
            const rightIdx = i - itdSamples;

            // ILD处理
            const leftGain = horizontalAngle > 0 ? 1 / ildLinear : 1;
            const rightGain = horizontalAngle < 0 ? 1 / ildLinear : 1;

            if (leftIdx >= 0 && leftIdx < input.length) {
                outputLeft[leftIdx] += input[i] * leftGain;
            }
            if (rightIdx >= 0 && rightIdx < input.length) {
                outputRight[rightIdx] += input[i] * rightGain;
            }
        }

        // 混响部分直接复制到双耳
        // 卷积后的处理
        return { left: outputLeft, right: outputRight };
    }

    /**
     * 快速卷积（使用FFT）
     * @param {Float32Array} input - 输入信号
     * @param {Float32Array} ir - 脉冲响应
     * @returns {Float32Array} 卷积结果
     */
    convolve(input, ir) {
        const n = input.length + ir.length - 1;
        const nfft = 1 << Math.ceil(Math.log2(n));

        // 简单的直接卷积（对于短IR更高效）
        const output = new Float32Array(n);

        for (let i = 0; i < input.length; i++) {
            for (let j = 0; j < ir.length && i + j < n; j++) {
                output[i + j] += input[i] * ir[j];
            }
        }

        return output;
    }
}

// 导出模块
if (typeof module !== 'undefined' && module.exports) {
    module.exports = RIRGenerator;
}
