import React from 'react';
import {Composition} from 'remotion';
import {NodeFlowLaunch} from './NodeFlowLaunch';

export const RemotionRoot: React.FC = () => (
  <Composition
    id="NodeFlowLaunch"
    component={NodeFlowLaunch}
    durationInFrames={1680}
    fps={30}
    width={1920}
    height={1080}
  />
);
