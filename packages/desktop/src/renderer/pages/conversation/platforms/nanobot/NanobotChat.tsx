import React from 'react';

const NanobotChat: React.FC<{
  conversation_id: string;
  workspace?: string;
  cron_job_id?: string;
  loadedSkills?: string[];
}> = () => {
  return <div>Nanobot Chat</div>;
};

export default NanobotChat;
